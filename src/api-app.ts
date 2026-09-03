import express from "express";
import cors from "cors";

const app = express();
const router = express.Router();
const webhookCache = new Map<string, any>();


app.use(cors());
app.use(express.json());

// API Routes
router.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

router.post("/initiate-payment", async (req, res) => {
  console.log("Received payment request:", req.body);
  const { phone, amount, currency, countryCode, email, userId } = req.body;

  if (!phone || !amount || !currency) {
    return res.status(400).json({ error: 'Champs manquants' });
  }

  // Cleanup phone number (remove +, spaces, etc)
  let sanitizedPhone = phone.replace(/\D/g, '');

  const cCode = (countryCode || 'CM').toUpperCase();
  let formattedPhone = sanitizedPhone;

  // Guarantee format: country code + local number (e.g. 237691234567) without the +
  if (cCode === 'CM') {
      // Cameroonian numbers are 9 digits local. 
      // If it has country code, it's 12 digits.
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

  if (formattedPhone.length < 8) {
    return res.status(400).json({ error: 'Numéro de téléphone invalide' });
  }

  const transactionId = `TXN_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  try {
    let paymentData: any = {};

    // ===== INTEGRATION FAPSHI =====
    const fapshiApiUser = (process.env.FAPSHI_API_USER || '7cad0afd-813d-41b7-b31f-7513a0ff3ceb').trim();
    const fapshiApiKey = (process.env.FAPSHI_API_KEY || 'FAK_4e86c70d587fe43b9328e4ae9a1dac0c').trim();

    // Prepare phone for Fapshi (9 digits for CM)
    let fapshiPhone = formattedPhone;
    if (fapshiPhone.startsWith('237') && fapshiPhone.length === 12) {
       fapshiPhone = fapshiPhone.substring(3);
    }

    const payload = {
      amount: parseInt(amount, 10),
      phone: fapshiPhone,
      email: email || 'anonymous@pay-me.local',
      externalId: transactionId,
      message: "Paiement TikTak"
    };

    console.log(`[FAPSHI] 🚀 Initiating direct-pay request to Fapshi...`, {
      url: "https://live.fapshi.com/direct-pay",
      phone: fapshiPhone,
      amount: parseInt(amount, 10),
      externalId: transactionId
    });

    const chargeRes = await fetch("https://live.fapshi.com/direct-pay", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apiuser": fapshiApiUser,
        "apikey": fapshiApiKey
      },
      body: JSON.stringify(payload)
    });

    let gatewayRef = transactionId;
    let paymentDataStatus = 'pending';
    
    if (!chargeRes.ok) {
      const errorText = await chargeRes.text();
      console.error(`[FAPSHI] ❌ HTTP Error ${chargeRes.status}:`, errorText);
      let errorMsg = errorText;
      try {
        const jsonErr = JSON.parse(errorText);
        if (jsonErr && (jsonErr.message || jsonErr.error)) {
          errorMsg = jsonErr.message || jsonErr.error;
        }
      } catch (e) {}

      if (typeof errorMsg === 'object') {
          try { errorMsg = JSON.stringify(errorMsg); } catch(e) {}
      }

      return res.status(chargeRes.status).json({ 
        error: `Erreur Fapshi (${chargeRes.status}): ${errorMsg}`,
        details: errorMsg
      });
    }

    const responseData = await chargeRes.json();
    console.log("[FAPSHI] ✅ Direct-pay request successfully dispatched:", responseData);

    // Fapshi returns transId directly on success (e.g. { message: "...", transId: "..." })
    gatewayRef = responseData?.transId || responseData?.id || transactionId;
    
    paymentData = {
      reference: transactionId,
      gatewayRef: gatewayRef,
      status: paymentDataStatus,
      provider: 'fapshi'
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
    console.error("[PAYMENT] Initiation Exception:", error);
    res.status(500).json({ error: error.message || 'Une erreur est survenue lors de l\'initiation du paiement' });
  }
});

router.get("/payment-status/:reference", async (req, res) => {
  const { reference } = req.params;
  const { provider, gatewayRef } = req.query; 
  
  console.log(`[STATUS CHECK] Checking status for ${reference} (gatewayRef: ${gatewayRef}) via ${provider}`);

  if (!provider) {
     return res.status(400).json({ error: 'Provider inconnu' });
  }

  try {
    let currentStatus = 'pending';
    let failReason = '';

    // First, check our local webhook cache
    const hookData = webhookCache.get(gatewayRef as string) || webhookCache.get(reference);
    if (hookData) {
      console.log(`[STATUS CHECK] Found in webhook cache:`, hookData);
      const hookStatus = String(hookData.status || hookData.state || hookData.event || '').toUpperCase();
      if (['SUCCESS', 'SUCCESSFUL', 'COMPLETED', 'PAID'].includes(hookStatus)) {
        currentStatus = 'success';
      } else if (['FAILED', 'EXPIRED', 'CANCELED', 'CANCELLED'].includes(hookStatus)) {
        currentStatus = 'failed';
        let hMsg = hookData.message || 'Transaction non complétée';
        if (typeof hMsg === 'object') {
           try { hMsg = JSON.stringify(hMsg); } catch(e) {}
        }
        failReason = String(hMsg);
      }
    } else if (provider === 'fapshi' && gatewayRef) {
      const fapshiApiUser = (process.env.FAPSHI_API_USER || '7cad0afd-813d-41b7-b31f-7513a0ff3ceb').trim();
      const fapshiApiKey = (process.env.FAPSHI_API_KEY || 'FAK_4e86c70d587fe43b9328e4ae9a1dac0c').trim();

      if (fapshiApiUser && fapshiApiKey) {
        try {
           console.log(`[FAPSHI] Querying status from https://live.fapshi.com/payment-status/${gatewayRef}`);
           const statusResponse = await fetch(`https://live.fapshi.com/payment-status/${gatewayRef}`, {
             headers: {
               "apiuser": fapshiApiUser,
               "apikey": fapshiApiKey
             }
           });
           
           if (statusResponse.ok) {
             const statusData = await statusResponse.json();
             console.log(`[FAPSHI] Status response:`, statusData);
             const rawStatus = String(statusData?.status || '').toUpperCase();
             
             // Check if payment is successful based on Fapshi response format
             if (['SUCCESSFUL', 'SUCCESS', 'COMPLETED', 'PAID'].includes(rawStatus)) {
               currentStatus = 'success';
             } else if (['FAILED', 'EXPIRED', 'CANCELLED', 'CANCELED'].includes(rawStatus)) {
               currentStatus = 'failed';
               let fMsg = statusData?.message || (rawStatus === 'EXPIRED' ? 'Session de paiement expirée' : 'Paiement échoué');
               if (typeof fMsg === 'object') {
                 try { fMsg = JSON.stringify(fMsg); } catch(e) {}
               }
               failReason = String(fMsg);
             } else {
               currentStatus = 'pending';
             }
           } else {
             const errText = await statusResponse.text();
             console.warn(`[FAPSHI] Status endpoint returned HTTP ${statusResponse.status}: ${errText}`);
           }
        } catch (apiError) {
           console.warn("[FAPSHI] Status check error:", apiError);
        }
      }
    }

    res.status(200).json({ status: currentStatus, reason: failReason, transaction: { reference, gatewayRef } });
  } catch (error: any) {
    console.error("[STATUS CHECK] Error:", error);
    res.status(500).json({ error: error.message || 'Erreur lors de la vérification du statut' });
  }
});

router.post("/payment-webhook", async (req, res) => {
  console.log("🔥 webhook received in /payment-webhook !", req.body);
  const { reference, status, event, transactionId, id, state, transId } = req.body;
  const refKey = reference || transId || transactionId || id || event;
  if (refKey) {
     webhookCache.set(refKey, req.body);
  }
  res.status(200).json({ received: true });
});

// also bind to GET just in case Tara money uses GET ?
router.get("/payment-webhook", async (req, res) => {
  console.log("🔥 GET webhook received !", req.query);
  const { reference, status, event, transactionId, id, state, transId } = req.query;
  const refKey = reference || transId || transactionId || id || event;
  if (refKey) {
     webhookCache.set(refKey as string, req.query);
  }
  res.status(200).json({ received: true });
});

// App Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Server-side Error caught by middleware:", err);
  res.status(500).json({ error: "Internal Server Error" });
});

// Mount the router under both /api and / for compatibility with Netlify Functions
app.use("/api", router);
app.use("/", router);

export default app;
