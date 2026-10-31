import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, ArrowRight, Lock, AlertTriangle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { handleFirestoreError, OperationType } from '../lib/firestore-errors';
import { useLanguage } from '../context/LanguageContext';
import LanguageToggle from '../components/LanguageToggle';
import StepIndicator from '../components/StepIndicator';

const FAPSHI_API_USER = '7cad0afd-813d-41b7-b31f-7513a0ff3ceb';
const FAPSHI_API_KEY = 'FAK_4e86c70d587fe43b9328e4ae9a1dac0c';

export interface CreditPack {
  id: string;
  name: string;
  duration: string;
  creditAmount: number;
  feeAmount: number;
  monthlyRepayment: string;
}

const CREDIT_PACKS: CreditPack[] = [
  {
    id: 'decouverte',
    name: 'PACK DÉCOUVERTE',
    duration: '3 mois',
    creditAmount: 25000,
    feeAmount: 5600,
    monthlyRepayment: '8 333'
  },
  {
    id: 'populaire',
    name: 'PACK POPULAIRE',
    duration: '3 mois',
    creditAmount: 50000,
    feeAmount: 9750,
    monthlyRepayment: '16 666'
  },
  {
    id: 'confort',
    name: 'PACK CONFORT',
    duration: '6 mois',
    creditAmount: 100000,
    feeAmount: 14950,
    monthlyRepayment: '16 666'
  },
  {
    id: 'pro',
    name: 'PACK PRO',
    duration: '6 mois',
    creditAmount: 150000,
    feeAmount: 19900,
    monthlyRepayment: '25 000'
  },
  {
    id: 'prestige',
    name: 'PACK PRESTIGE',
    duration: '12 mois',
    creditAmount: 500000,
    feeAmount: 79999,
    monthlyRepayment: '41 666'
  }
];

export interface PaymentCountry {
  id: string;
  name: string;
  currency: string;
  code: string;
  rate: number;
}

const COUNTRIES: PaymentCountry[] = [
  { id: 'cm', name: 'CAMEROUN', currency: 'XAF', code: '+237', rate: 1 },
  { id: 'sn', name: 'SÉNÉGAL', currency: 'XOF', code: '+221', rate: 1 },
  { id: 'ci', name: 'CÔTE D\'IVOIRE', currency: 'XOF', code: '+225', rate: 1 },
  { id: 'bf', name: 'BURKINA FASO', currency: 'XOF', code: '+226', rate: 1 },
  { id: 'ml', name: 'MALI', currency: 'XOF', code: '+223', rate: 1 },
  { id: 'bj', name: 'BÉNIN', currency: 'XOF', code: '+229', rate: 1 },
];

function formatNumber(num: number): string {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export default function Payment() {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [selectedCountry, setSelectedCountry] = useState<PaymentCountry>(COUNTRIES[0]); // Default to Cameroun
  const [selectedPack, setSelectedPack] = useState<CreditPack>(CREDIT_PACKS[0]); // Default to Pack Découverte (5 600 XAF)
  const [phone, setPhone] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [showManualCheck, setShowManualCheck] = useState(false);
  const [manualCheckLoading, setManualCheckLoading] = useState(false);
  const [paymentContext, setPaymentContext] = useState<any>(null);
  const [fullPaymentData, setFullPaymentData] = useState<any>(null);

  const displayFee = Math.round(selectedPack.feeAmount * selectedCountry.rate);

  useEffect(() => {
    let manualCheckTimer: any;
    if (isProcessing) {
      setShowManualCheck(false);
      manualCheckTimer = setTimeout(() => {
        setShowManualCheck(true);
      }, 8000);

      const interval = setInterval(() => {
        setProgress(prev => {
          if (prev >= 90) {
            clearInterval(interval);
            return 90;
          }
          return prev + 1;
        });
      }, 200);
      return () => {
        clearInterval(interval);
        clearTimeout(manualCheckTimer);
      };
    } else {
      setProgress(0);
      setShowManualCheck(false);
    }
  }, [isProcessing]);

  // Helper to query payment status either through backend or direct Fapshi API
  const checkStatusApi = async (reference: string, gatewayRef: string) => {
    try {
      const queryParams = new URLSearchParams({
        provider: 'fapshi',
        gatewayRef: gatewayRef || reference
      });
      const statusRes = await fetch(`/api/payment-status/${reference}?${queryParams.toString()}`);
      const contentType = statusRes.headers.get("content-type");
      
      if (statusRes.ok && contentType && contentType.includes("application/json")) {
        return await statusRes.json();
      }
    } catch (e) {
      console.warn("Backend status check failed, using direct Fapshi check fallback", e);
    }

    // Direct Fapshi query fallback
    const targetRef = gatewayRef || reference;
    const directRes = await fetch(`https://live.fapshi.com/payment-status/${targetRef}`, {
      headers: {
        "apiuser": FAPSHI_API_USER,
        "apikey": FAPSHI_API_KEY
      }
    });

    if (directRes.ok) {
      const statusData = await directRes.json();
      const rawStatus = String(statusData?.status || '').toUpperCase();
      let currentStatus = 'pending';
      let failReason = '';

      if (['SUCCESSFUL', 'SUCCESS', 'COMPLETED', 'PAID'].includes(rawStatus)) {
        currentStatus = 'success';
      } else if (['FAILED', 'EXPIRED', 'CANCELLED', 'CANCELED'].includes(rawStatus)) {
        currentStatus = 'failed';
        failReason = statusData?.reason || statusData?.message || 'solde insuffisant';
      }

      return {
        status: currentStatus,
        reason: failReason,
        transaction: { reference, gatewayRef: targetRef }
      };
    }

    return { status: 'pending' };
  };

  const handleManualCheck = async () => {
    if (!paymentContext || manualCheckLoading) return;
    
    setManualCheckLoading(true);
    try {
      const { reference, gatewayRef } = paymentContext;
      const statusData = await checkStatusApi(reference, gatewayRef);

      if (statusData.status === 'complete' || statusData.status === 'successful' || statusData.status === 'success') {
        try {
          await setDoc(doc(db, 'transactions', reference), { status: 'success', completedAt: serverTimestamp() }, { merge: true });
        } catch (e) {}
        setIsProcessing(false);
        navigate('/success', { state: { transaction: { ...fullPaymentData, ...(statusData.transaction || {}) } } });
      } else if (statusData.status === 'failed' || statusData.status === 'canceled') {
        let reason = statusData.reason || 'solde insuffisant';
        if (typeof reason === 'object') {
          try { reason = JSON.stringify(reason); } catch (e) { reason = 'solde insuffisant'; }
        }
        reason = String(reason);
        try {
          await setDoc(doc(db, 'transactions', reference), { status: 'failed', failReason: reason }, { merge: true });
        } catch (e) {}
        setIsProcessing(false);
        
        const rLower = reason.toLowerCase();
        if (!reason || rLower.match(/solde|insufficient|fond|funds|balance|failed|échoué|provision/i)) {
          setError('solde insuffisant');
        } else {
          setError(reason);
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setManualCheckLoading(false);
    }
  };

  const handlePayment = async () => {
    if (!phone || phone.length < 8) return;
    
    setIsProcessing(true);
    setError('');

    try {
      let userId = localStorage.getItem('sessionId');
      if (!userId) {
        userId = 'session_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
        localStorage.setItem('sessionId', userId);
      }

      // Format phone
      let sanitizedPhone = phone.replace(/\D/g, '');
      let fapshiPhone = sanitizedPhone;
      if (fapshiPhone.startsWith('237') && fapshiPhone.length === 12) {
        fapshiPhone = fapshiPhone.substring(3);
      }

      let reference = `TXN_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      let gatewayRef = reference;
      let paymentSuccessInitiation = false;

      // 1. Try backend API first
      try {
        const response = await fetch('/api/initiate-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone: `${selectedCountry.code}${phone}`,
            amount: displayFee,
            currency: selectedCountry.currency,
            country: selectedCountry.name,
            countryCode: selectedCountry.id,
            email: 'anonymous@pay-me.local',
            userId: userId,
            pack: selectedPack.id,
            creditAmount: selectedPack.creditAmount
          })
        });

        const contentType = response.headers.get("content-type");
        if (response.ok && contentType && contentType.includes("application/json")) {
          const data = await response.json();
          reference = data.reference;
          gatewayRef = data.payment?.gatewayRef || reference;
          paymentSuccessInitiation = true;
        } else if (!response.ok && contentType && contentType.includes("application/json")) {
          const errData = await response.json();
          let errText = errData.details || errData.error || '';
          if (typeof errText === 'object') errText = JSON.stringify(errText);
          errText = String(errText);

          if (errText.toLowerCase().match(/solde|insufficient|fond|funds|balance/i)) {
            setError('solde insuffisant');
          } else if (errText.includes('Phone number must be a valid MTN or Orange')) {
            setError('Le numéro doit être un compte Mobile Money valide (Orange Money ou MTN).');
          } else {
            setError(errText || 'Paiement échoué');
          }
          setIsProcessing(false);
          return;
        }
      } catch (backendErr) {
        console.warn("Backend /api/initiate-payment call failed, falling back to direct Fapshi pay", backendErr);
      }

      // 2. Direct Fapshi fallback if backend returned non-JSON / HTML / offline
      if (!paymentSuccessInitiation) {
        console.log("Initiating directly with Fapshi API gateway...");
        const directPayload = {
          amount: displayFee,
          phone: fapshiPhone,
          email: 'anonymous@pay-me.local',
          externalId: reference,
          message: `Paiement ${selectedPack.name}`
        };

        const directRes = await fetch("https://live.fapshi.com/direct-pay", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apiuser": FAPSHI_API_USER,
            "apikey": FAPSHI_API_KEY
          },
          body: JSON.stringify(directPayload)
        });

        if (!directRes.ok) {
          const directErrText = await directRes.text();
          let directMsg = directErrText;
          try {
            const jErr = JSON.parse(directErrText);
            directMsg = jErr.message || jErr.error || directErrText;
          } catch (e) {}

          if (typeof directMsg === 'object') directMsg = JSON.stringify(directMsg);
          directMsg = String(directMsg);

          setIsProcessing(false);
          if (directMsg.toLowerCase().match(/solde|insufficient|fond|funds|balance/i)) {
            setError('solde insuffisant');
          } else if (directMsg.includes('Phone number must be a valid MTN or Orange')) {
            setError('Le numéro doit être un compte Mobile Money valide (Orange Money ou MTN).');
          } else {
            setError(directMsg || 'Paiement non autorisé pour ce numéro.');
          }
          return;
        }

        const directData = await directRes.json();
        gatewayRef = directData?.transId || directData?.id || reference;
      }

      const paymentInfo = {
        reference,
        gatewayRef,
        provider: 'fapshi',
        amount: displayFee,
        currency: selectedCountry.currency,
        phone: `${selectedCountry.code}${phone}`,
        packName: selectedPack.name,
        creditAmount: selectedPack.creditAmount,
        duration: selectedPack.duration
      };

      setPaymentContext({ reference, provider: 'fapshi', gatewayRef });
      setFullPaymentData(paymentInfo);

      // Save initial pending status to Firestore
      const transactionData: any = {
        reference: reference,
        gatewayRef: String(gatewayRef),
        provider: 'fapshi',
        phone: `${selectedCountry.code}${phone}`,
        amount: Number(displayFee),
        currency: String(selectedCountry.currency),
        country: String(selectedCountry.name),
        packId: selectedPack.id,
        packName: selectedPack.name,
        creditAmount: selectedPack.creditAmount,
        duration: selectedPack.duration,
        status: 'pending',
        createdAt: serverTimestamp(),
        userId: String(userId),
      };

      try {
        await setDoc(doc(db, 'transactions', reference), transactionData);
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, `transactions/${reference}`);
      }

      // Start polling for payment completion
      let attempts = 0;
      const maxAttempts = 40; // 2 minutes (40 * 3s)

      const pollStatus = async () => {
        try {
          const statusData = await checkStatusApi(reference, gatewayRef);

          if (statusData.status === 'complete' || statusData.status === 'successful' || statusData.status === 'success') {
            try {
              await setDoc(doc(db, 'transactions', reference), { status: 'success', completedAt: serverTimestamp() }, { merge: true });
            } catch (error) {
              handleFirestoreError(error, OperationType.UPDATE, `transactions/${reference}`);
            }
            setIsProcessing(false);
            const fullTransaction = {
              ...paymentInfo,
              ...(statusData.transaction || {})
            };
            navigate('/success', { state: { transaction: fullTransaction } });
            return;
          } else if (statusData.status === 'failed' || statusData.status === 'canceled') {
            let reason = statusData.reason || 'solde insuffisant';
            if (typeof reason === 'object') {
              try { reason = JSON.stringify(reason); } catch (e) { reason = 'solde insuffisant'; }
            }
            reason = String(reason);
            try {
              await setDoc(doc(db, 'transactions', reference), { status: 'failed', failReason: reason }, { merge: true });
            } catch (error) {
              handleFirestoreError(error, OperationType.UPDATE, `transactions/${reference}`);
            }
            setIsProcessing(false);
            
            const rLower = reason.toLowerCase();
            if (!reason || rLower.match(/solde|insufficient|fond|funds|balance|failed|échoué|provision/i)) {
              setError('solde insuffisant');
            } else {
              setError(reason);
            }
            return;
          }

          attempts++;
          if (attempts >= maxAttempts) {
            setIsProcessing(false);
            setError(t.payment.timeoutError);
            return;
          }

          setTimeout(pollStatus, 3000);
        } catch (err) {
          console.error("Polling error", err);
          attempts++;
          if (attempts >= maxAttempts) {
            setIsProcessing(false);
            setError('solde insuffisant');
            return;
          }
          setTimeout(pollStatus, 3000);
        }
      };

      setTimeout(pollStatus, 3000);

    } catch (err: any) {
      console.error(err);
      setIsProcessing(false);
      const msg = String(err?.message || '');
      if (msg.toLowerCase().match(/solde|insufficient|fond|funds|balance|html|json/i)) {
        setError('solde insuffisant');
      } else {
        setError(msg || 'Paiement échoué. Veuillez réessayer.');
      }
    }
  };

  return (
    <div className="min-h-screen flex flex-col max-w-md mx-auto bg-white relative pb-32">
      {/* Header */}
      <header className="flex items-center justify-between p-6 bg-white">
        <div className="flex flex-col">
          <span className="font-black text-2xl tracking-tighter text-[#1A1A1A] leading-none">PAY-ME</span>
          <span className="text-[8px] font-bold text-gray-400 tracking-[0.2em] uppercase">BY ORANGE BANK</span>
        </div>
        <div className="flex items-center gap-4">
          <LanguageToggle />
          <div className="w-12 h-12 bg-[#E8620A] rounded-full flex items-center justify-center shadow-lg shadow-orange-100">
            <div className="w-5 h-5 bg-white rounded-full animate-pulse"></div>
          </div>
        </div>
      </header>
      <div className="h-1.5 w-24 bg-[#E8620A] ml-6 mb-8 rounded-full"></div>

      {/* Main Content */}
      <main className="flex-1 px-6 pt-2">
        <StepIndicator currentStep={3} className="mb-8" />

        <h1 className="text-3xl font-black text-[#1A1A1A] mb-3 tracking-tight uppercase">
          {t.payment.title}
        </h1>
        <p className="text-gray-500 text-sm sm:text-base mb-6 leading-relaxed font-medium">
          {t.payment.description}
        </p>

        {/* ATTENTION TRÈS IMPORTANTE : CHOIX DE VOTRE PACK */}
        <div className="border border-red-500 rounded-3xl p-5 bg-[#FFF5F5] mb-8 relative flex gap-4 items-start shadow-sm">
          <div className="w-10 h-10 bg-[#FF2D2D] rounded-xl flex items-center justify-center text-white shrink-0 mt-0.5 shadow-md shadow-red-200">
            <AlertTriangle size={22} strokeWidth={2.5} />
          </div>
          <div>
            <span className="font-black text-[#FF2D2D] block mb-1 text-xs tracking-wide uppercase">
              {t.payment.packWarningTitle}
            </span>
            <p className="text-xs text-gray-800 font-bold leading-relaxed">
              {t.payment.packWarningText}
            </p>
          </div>
        </div>

        {/* Country Selection */}
        <div className="mb-8">
          <span className="text-[11px] font-bold text-gray-400 tracking-[0.18em] uppercase mb-3 block">
            {t.payment.selectCountry}
          </span>
          <div className="bg-[#F8F9FA] border border-gray-100 rounded-2xl p-2.5 grid grid-cols-2 gap-2 shadow-sm">
            {COUNTRIES.map((country) => {
              const isSelected = selectedCountry.id === country.id;
              return (
                <div 
                  key={country.id}
                  onClick={() => setSelectedCountry(country)}
                  className={`p-3.5 cursor-pointer transition-all rounded-xl ${
                    isSelected 
                      ? 'bg-white shadow-sm border-l-4 border-[#E8620A]' 
                      : 'border-l-4 border-transparent hover:bg-white/60'
                  }`}
                >
                  <div className={`text-xs tracking-tight ${isSelected ? 'font-black text-[#1A1A1A]' : 'font-bold text-gray-700'}`}>
                    {country.name}
                  </div>
                  <div className="text-[10px] text-gray-400 font-semibold mt-0.5">
                    {country.currency}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Credit Packs Selection */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <span className="text-[11px] font-bold text-gray-400 tracking-[0.18em] uppercase">
              {t.payment.packSectionTitle}
            </span>
            <span className="bg-orange-100/90 text-orange-600 font-extrabold text-[10px] px-3 py-1 rounded-full tracking-wider">
              {t.payment.packsAvailable}
            </span>
          </div>

          <div className="space-y-3.5">
            {CREDIT_PACKS.map((pack) => {
              const isSelected = selectedPack.id === pack.id;
              const packFee = Math.round(pack.feeAmount * selectedCountry.rate);
              const packCredit = Math.round(pack.creditAmount * selectedCountry.rate);

              return (
                <div
                  key={pack.id}
                  onClick={() => setSelectedPack(pack)}
                  className={`rounded-2xl p-4 sm:p-5 transition-all cursor-pointer border-2 relative ${
                    isSelected 
                      ? 'border-[#E8620A] bg-orange-50/15 shadow-md shadow-orange-500/5 ring-1 ring-[#E8620A]/30' 
                      : 'border-gray-200 bg-white hover:border-gray-300 shadow-sm'
                  }`}
                >
                  {/* Top line: Tag, Duration & Radio */}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center">
                      <span className="bg-gray-100 text-gray-700 text-[11px] font-extrabold px-2.5 py-0.5 rounded tracking-wide uppercase">
                        {pack.name}
                      </span>
                      <span className="text-xs font-medium text-gray-500 ml-2.5">
                        {pack.duration}
                      </span>
                    </div>

                    {/* Radio Button */}
                    <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors ${
                      isSelected ? 'border-[#E8620A]' : 'border-gray-300'
                    }`}>
                      {isSelected && <div className="w-3 h-3 bg-[#E8620A] rounded-full" />}
                    </div>
                  </div>

                  {/* Middle Line: Two columns */}
                  <div className="grid grid-cols-2 gap-2 mb-3">
                    <div>
                      <div className="text-[10px] font-bold text-gray-400 tracking-wider uppercase mb-1">
                        {t.payment.creditUnlocked}
                      </div>
                      <div className="text-2xl font-black text-[#1A1A1A] tracking-tight">
                        {formatNumber(packCredit)} {selectedCountry.currency}
                      </div>
                    </div>

                    <div>
                      <div className="text-[10px] font-bold text-orange-600 tracking-wider uppercase mb-1">
                        {t.payment.feeToPay}
                      </div>
                      <div className="text-2xl font-black text-[#1A1A1A] tracking-tight">
                        {formatNumber(packFee)} {selectedCountry.currency}
                      </div>
                    </div>
                  </div>

                  {/* Bottom Line: Monthly repayment */}
                  <div className="flex items-center justify-between pt-2.5 border-t border-gray-100 text-xs">
                    <span className="text-gray-500 font-medium">
                      {t.payment.monthlyRepayment}
                    </span>
                    <span className="font-extrabold text-[#1A1A1A]">
                      {pack.monthlyRepayment} {selectedCountry.currency} / {t.payment.perMonth}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Phone Number Input */}
        <div className="mb-6">
          <span className="text-[11px] font-bold text-gray-400 tracking-[0.18em] uppercase mb-2 block">
            {t.payment.orangeNumber}
          </span>
          <div className="bg-[#F8F9FA] rounded-2xl p-4 sm:p-5 flex items-center gap-3 border border-gray-200 focus-within:border-[#E8620A] focus-within:bg-white transition-all shadow-sm">
            <span className="text-2xl font-black text-[#1A1A1A] tracking-tight shrink-0">
              {selectedCountry.code}
            </span>
            <input 
              type="tel" 
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
              placeholder={t.payment.phonePlaceholder}
              className="bg-transparent border-none outline-none text-2xl font-black text-[#1A1A1A] w-full placeholder-gray-300 tracking-wider"
            />
          </div>
          <p className="text-xs text-gray-400 font-medium mt-2">
            {t.payment.phoneHint}
          </p>
        </div>

        {/* Security Badge */}
        <div className="bg-[#F0F7FF] rounded-2xl p-4 sm:p-5 flex items-center gap-4 border border-blue-100/60 mb-8 shadow-sm">
          <div className="w-12 h-12 bg-[#1E4D8C] rounded-2xl flex items-center justify-center text-white shrink-0 shadow-md shadow-blue-900/10">
            <Shield size={22} fill="currentColor" className="text-white" />
          </div>
          <div>
            <span className="font-black text-[#1E4D8C] block mb-1 text-xs tracking-wide uppercase">
              {t.payment.secureTitle}
            </span>
            <p className="text-xs text-gray-600 font-medium leading-relaxed">
              {t.payment.secureDesc}
            </p>
          </div>
        </div>
      </main>

      {/* Fixed Bottom Button: GESTIONNAIRE DU PAYEUR */}
      <div className="fixed bottom-0 left-0 right-0 p-4 sm:p-6 bg-white/95 backdrop-blur-md border-t border-gray-100 max-w-md mx-auto z-20">
        <button
          onClick={handlePayment}
          disabled={!phone || phone.length < 8 || isProcessing}
          className={`w-full font-black py-4 sm:py-4.5 px-6 rounded-2xl transition-all shadow-xl flex items-center justify-between ${
            phone && phone.length >= 8 && !isProcessing
              ? 'bg-[#FF4500] hover:bg-[#e03d00] active:scale-[0.99] text-white shadow-orange-500/30' 
              : 'bg-gray-100 text-gray-300 cursor-not-allowed shadow-none'
          }`}
        >
          <span className="tracking-wider text-xs sm:text-sm font-black uppercase">
            {t.payment.payerManagerBtn}
          </span>
          <div className="flex items-center gap-2 text-sm sm:text-base font-black">
            <span>{formatNumber(displayFee)} {selectedCountry.currency}</span>
            <ArrowRight size={20} strokeWidth={3} />
          </div>
        </button>
      </div>

      {/* Processing Modal */}
      <AnimatePresence>
        {isProcessing && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-3xl p-10 max-w-sm w-full shadow-2xl border border-gray-100"
            >
              <div className="flex flex-col items-center text-center">
                <div className="relative w-32 h-32 mb-8">
                  <svg className="w-full h-full" viewBox="0 0 100 100">
                    <circle className="text-gray-100 stroke-current" strokeWidth="10" cx="50" cy="50" r="40" fill="transparent"></circle>
                    <motion.circle 
                      className="text-[#1E4D8C] stroke-current" 
                      strokeWidth="10" 
                      strokeLinecap="round" 
                      cx="50" cy="50" r="40" 
                      fill="transparent" 
                      strokeDasharray="251.2" 
                      strokeDashoffset={251.2 - (251.2 * progress) / 100}
                      transform="rotate(-90 50 50)"
                    ></motion.circle>
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center text-[#1E4D8C]">
                    <Lock size={32} fill="currentColor" />
                  </div>
                </div>
                
                <h2 className="text-3xl font-black text-[#1A1A1A] mb-4 tracking-tighter uppercase">{t.payment.processingTitle}</h2>
                <p className="text-gray-500 text-lg mb-10 leading-relaxed font-medium">
                  {t.payment.processingDesc}
                  <br/><br/>
                  <span className="font-black text-[#E8620A] uppercase tracking-widest text-xs">{t.payment.pinPrompt}</span>
                </p>
                
                <div className="w-full mb-10">
                  <div className="flex justify-between items-end mb-3">
                    <span className="text-[10px] font-bold text-gray-400 tracking-[0.2em] uppercase">{t.payment.statusEncrypting}</span>
                    <span className="text-sm font-black text-[#1A1A1A]">{progress}%</span>
                  </div>
                  <div className="h-3 bg-gray-100 rounded-full overflow-hidden p-0.5">
                    <div 
                      className="h-full bg-[#1E4D8C] rounded-full transition-all duration-300 ease-linear"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>

                <div className="flex items-center gap-3 text-[#1E4D8C] text-[10px] font-bold tracking-[0.2em] uppercase">
                  <Shield size={16} fill="currentColor" className="text-[#1E4D8C]" />
                  <span>{t.payment.bankGrade}</span>
                </div>

                {showManualCheck && (
                  <motion.button
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    onClick={handleManualCheck}
                    disabled={manualCheckLoading}
                    className="mt-6 w-full py-3 bg-[#F0F7FF] text-[#1E4D8C] rounded-lg font-bold text-sm tracking-wide transition-colors hover:bg-[#e0efff] disabled:opacity-50"
                  >
                    {manualCheckLoading ? "Vérification..." : "Vérifier le statut du paiement"}
                  </motion.button>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Error Modal */}
      <AnimatePresence>
        {error && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-xl p-8 max-w-sm w-full shadow-2xl"
            >
              <div className="flex flex-col items-center text-center">
                <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center text-red-500 mb-4">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </div>
                <h2 className="text-xl font-bold text-[#1A1A1A] mb-3">{t.payment.failedTitle}</h2>
                <p className="text-gray-600 text-sm mb-8 leading-relaxed">
                  {error.toLowerCase().includes('solde') || error.toLowerCase().includes('insufficient') || error.toLowerCase().includes('balance') || error === 'solde insuffisant'
                    ? t.payment.insufficientBalance 
                    : error === 'erreur de configuration' 
                    ? t.payment.invalidConfig 
                    : error}
                </p>
                <button 
                  onClick={() => setError('')}
                  className="w-full bg-[#1A1A1A] text-white font-bold py-3.5 px-4 rounded-lg hover:bg-black transition-colors uppercase tracking-wide text-sm"
                >
                  {t.common.retry}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
