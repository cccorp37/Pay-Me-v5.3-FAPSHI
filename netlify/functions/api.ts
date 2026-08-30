import express from "express";
import cors from "cors";
import serverless from "serverless-http";

const app = express();
const router = express.Router();
const webhookCache = new Map<string, any>();

app.use(cors());
app.use(express.json());

// Helpers for operators
function getSoleasPayService(phone: string, country: string = 'CM') {
  const p = phone.replace(/(?!^\+)[^\d]/g, '').replace('+', '');
  const cCode = country.toUpperCase();
  
  let formattedPhone = p;
  
  if (cCode === 'CM') {
      if (formattedPhone.length === 9) {
          formattedPhone = '237' + formattedPhone;
      } else if (formattedPhone.length > 12 && formattedPhone.endsWith(formattedPhone.substring(formattedPhone.length - 9))) {
          formattedPhone = '237' + formattedPhone.substring(formattedPhone.length - 9);
      } else if (formattedPhone.length === 12 && !formattedPhone.startsWith('237')) {
          formattedPhone = '237' + formattedPhone.substring(3);
      }
  } else if (cCode === 'SN') {
      if (formattedPhone.length === 9) {
          formattedPhone = '221' + formattedPhone;
      } else if (formattedPhone.length > 12) {
          formattedPhone = '221' + formattedPhone.substring(formattedPhone.length - 9);
      }
  } else if (cCode === 'CI') {
      if (formattedPhone.length === 10) {
          formattedPhone = '225' + formattedPhone;
      } else if (formattedPhone.length > 13) {
          formattedPhone = '225' + formattedPhone.substring(formattedPhone.length - 10);
      }
  }

  let serviceId = "2"; // Orange Money CM par défaut
  if (cCode === 'CM' && formattedPhone.length === 12) {
     const localPrefix = formattedPhone.substring(3, 6);
     if (['690', '691', '692', '693', '694', '695', '696', '697', '698', '699', '655', '656', '657', '658', '659', '640'].includes(localPrefix)) {
         serviceId = "2"; // Orange Money CM
     } else if (['670', '671', '672', '673', '674', '675', '676', '677', '678', '679', '680', '682', '683', '650', '651', '652', '653', '654'].includes(localPrefix)) {
         serviceId = "1"; // MTN Mobile Money CM
     }
  } else if (cCode === 'SN') {
      serviceId = "24"; // Orange Money SN
  } else if (cCode === 'CI') {
      serviceId = "29"; // Orange Money CI
  }
  
  return { formattedPhone, serviceId };
}

router.get("/health", (req, res) => {
  console.log("Health check reached");
  res.json({ status: "ok", env: "netlify" });
});

router.post("/initiate-payment", async (req, res) => {
  console.log("Initiate payment reached");
  const { phone, amount, currency, countryCode, email } = req.body;

  if (!phone || !amount || !currency) {
    return res.status(400).json({ error: 'Champs manquants' });
  }

  const finalCountry = (countryCode || 'CM').toUpperCase();
  const { formattedPhone, serviceId } = getSoleasPayService(phone, finalCountry);

  if (formattedPhone.length < 8) {
    return res.status(400).json({ error: 'Numéro de téléphone invalide' });
  }

  const transactionId = `TXN_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  try {
    const soleasPublicKey = (process.env.SOLEASPAY_PUBLIC_KEY || '').trim();
    const soleasSecretKey = (process.env.SOLEASPAY_SECRET_KEY || 'SP_kU4Cb35nfHDdaX3jOwtzJkJCnhX6nXg2cN5fJsVLnSU').trim();

    if (!soleasPublicKey || !soleasSecretKey) {
      return res.status(500).json({ error: 'API Keys SoleasPay (SOLEASPAY_PUBLIC_KEY, SOLEASPAY_SECRET_KEY) manquantes sur Netlify.' });
    }

    const appHost = req.headers['x-forwarded-host'] || req.headers.host;
    const appProtocol = req.headers['x-forwarded-proto'] || 'https';
    const publicWebhookUrl = `${appProtocol}://${appHost}/api/payment-webhook`;

    const payload = {
      wallet: formattedPhone, // format 237xxxx sans +
      amount: amount,
      currency: currency.toUpperCase(),
      orderId: transactionId,
      description: "Paiement TikTak",
      payer: "Client TikTak",
      payerEmail: email || 'anonymous@pay-me.local',
      successUrl: publicWebhookUrl,
      failureUrl: publicWebhookUrl
    };

    console.log("Initiating SoleasPay payment with payload:", payload);

    const chargeRes = await fetch("https://soleaspay.com/api/agent/bills/v3", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": soleasPublicKey,
        "operation": "2",
        "service": serviceId
      },
      body: JSON.stringify(payload)
    });

    let gatewayRef = transactionId;
    let paymentDataStatus = 'pending';
    
    if (!chargeRes.ok) {
      const errorText = await chargeRes.text();
      let errorMsg = errorText;
      try {
        const jsonErr = JSON.parse(errorText);
        if (jsonErr && jsonErr.message) errorMsg = jsonErr.message;
      } catch (e) {}

      throw new Error(`Erreur HTTP SoleasPay: ${errorMsg}`);
    }

    const responseData = await chargeRes.json();
    console.log("SoleasPay API response:", responseData);

    if (responseData && (responseData.success === false || responseData.status === false)) {
      const errorMsg = responseData.message || 'Erreur inconnue';
      throw new Error(`Erreur API SoleasPay: ${errorMsg}`);
    }

    gatewayRef = responseData?.data?.payId || responseData?.payId || transactionId;
    
    const paymentData = {
      reference: transactionId,
      gatewayRef: gatewayRef,
      status: paymentDataStatus,
      provider: 'soleaspay'
    };

    const payment = {
      status: paymentData.status,
      reference: paymentData.reference,
      gatewayRef: paymentData.gatewayRef,
      provider: paymentData.provider,
      amount,
      currency,
      phone: formattedPhone
    };

    res.status(200).json({ reference: payment.reference, payment });

  } catch (error: any) {
    console.error("Payment initiation error:", error);
    res.status(500).json({ error: error.message || 'Une erreur est survenue lors de l\'initiation du paiement' });
  }
});

router.get("/payment-status/:reference", async (req, res) => {
  const { reference } = req.params;
  const { provider, gatewayRef } = req.query; 

  console.log(`Checking status for ${reference} via ${provider}`);

  try {
    let currentStatus = 'pending';
    let failReason = '';
    
    const hookData = webhookCache.get(gatewayRef as string) || webhookCache.get(reference);
    if (hookData) {
      const hookStatus = hookData.status || hookData.state || hookData.event;
      if (hookStatus === 'SUCCESS' || hookStatus === 'successful') currentStatus = 'success';
      else if (hookStatus === 'FAILED' || hookStatus === 'failed') {
        currentStatus = 'failed';
        failReason = hookData.message || 'Transaction échouée';
      }
    } else if (provider === 'soleaspay') {
      const soleasPublicKey = (process.env.SOLEASPAY_PUBLIC_KEY || '').trim();

      if (soleasPublicKey) {
        try {
           const statusResponse = await fetch(`https://soleaspay.com/api/agent/verif-pay?orderId=${reference}&payId=${gatewayRef}`, {
             headers: {
               "x-api-key": soleasPublicKey
             }
           });
           
           if (statusResponse.ok) {
             const statusData = await statusResponse.json();
             const rawStatus = statusData?.data?.status || statusData?.status;
             
             if (rawStatus === 'SUCCESSFUL' || rawStatus === 'SUCCESS' || rawStatus === 'successful' || rawStatus === 'success' || rawStatus === 1 || rawStatus === '1') currentStatus = 'success';
             else if (rawStatus === 'FAILED' || rawStatus === 'failed' || rawStatus === 3 || rawStatus === '3') {
               currentStatus = 'failed';
               failReason = statusData?.data?.message || statusData?.message || 'Transaction échouée';
             }
             else currentStatus = 'pending';
           } else {
             console.warn(`Status endpoint returned ${statusResponse.status}`);
           }
        } catch (apiError) {
           console.warn("SoleasPay status check error", apiError);
        }
      }
    }

    res.status(200).json({ status: currentStatus, reason: failReason, transaction: { reference, gatewayRef } });
  } catch (error: any) {
    console.error("Status check error:", error);
    res.status(500).json({ error: 'Erreur statut' });
  }
});

router.post("/payment-webhook", async (req, res) => {
  console.log("🔥 webhook received in /payment-webhook !", req.body);
  const { reference, status, event, transactionId, id, state } = req.body;
  const refKey = reference || transactionId || id || event;
  if (refKey) {
     webhookCache.set(refKey, req.body);
  }
  res.status(200).json({ received: true });
});

router.get("/payment-webhook", async (req, res) => {
  console.log("🔥 GET webhook received !", req.query);
  const { reference, status, event, transactionId, id, state } = req.query;
  const refKey = reference || transactionId || id || event;
  if (refKey) {
     webhookCache.set(refKey as string, req.query);
  }
  res.status(200).json({ received: true });
});

app.use("/api", router);
app.use("/", router);

export const handler = serverless(app);
