import express from "express";
import cors from "cors";
import serverless from "serverless-http";

const app = express();
const router = express.Router();
const webhookCache = new Map<string, any>();

app.use(cors());
app.use(express.json());

const FAPSHI_API_USER = (process.env.FAPSHI_API_USER || '7cad0afd-813d-41b7-b31f-7513a0ff3ceb').trim();
const FAPSHI_API_KEY = (process.env.FAPSHI_API_KEY || 'FAK_4e86c70d587fe43b9328e4ae9a1dac0c').trim();

// Health check
router.get("/health", (req, res) => {
  res.json({ status: "ok", env: "netlify", gateway: "fapshi" });
});

// Initiate Payment via Fapshi
router.post("/initiate-payment", async (req, res) => {
  console.log("[Netlify Fapshi] Received payment request:", req.body);
  const { phone, amount, currency, countryCode, email } = req.body;

  if (!phone || !amount || !currency) {
    return res.status(400).json({ error: 'Champs manquants (téléphone, montant ou devise)' });
  }

  // Cleanup phone number
  let sanitizedPhone = String(phone).replace(/\D/g, '');
  const cCode = (countryCode || 'CM').toUpperCase();
  let formattedPhone = sanitizedPhone;

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

  if (formattedPhone.length < 8) {
    return res.status(400).json({ error: 'Numéro de téléphone invalide' });
  }

  const transactionId = `TXN_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  try {
    // Prepare phone for Fapshi (9 digits for CM)
    let fapshiPhone = formattedPhone;
    if (fapshiPhone.startsWith('237') && fapshiPhone.length === 12) {
      fapshiPhone = fapshiPhone.substring(3);
    }

    const payload = {
      amount: parseInt(String(amount), 10),
      phone: fapshiPhone,
      email: email || 'anonymous@pay-me.local',
      externalId: transactionId,
      message: "Paiement TikTak"
    };

    console.log("[Netlify Fapshi] Calling https://live.fapshi.com/direct-pay with:", {
      phone: fapshiPhone,
      amount: payload.amount,
      externalId: transactionId
    });

    const chargeRes = await fetch("https://live.fapshi.com/direct-pay", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apiuser": FAPSHI_API_USER,
        "apikey": FAPSHI_API_KEY
      },
      body: JSON.stringify(payload)
    });

    if (!chargeRes.ok) {
      const errorText = await chargeRes.text();
      console.error(`[Netlify Fapshi] HTTP ${chargeRes.status}:`, errorText);
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
    console.log("[Netlify Fapshi] Success response:", responseData);

    const gatewayRef = responseData?.transId || responseData?.id || transactionId;

    const payment = {
      status: 'pending',
      reference: transactionId,
      gatewayRef: gatewayRef,
      provider: 'fapshi',
      amount,
      currency,
      phone: formattedPhone
    };

    res.status(200).json({ reference: payment.reference, payment });

  } catch (error: any) {
    console.error("[Netlify Fapshi] Payment initiation error:", error);
    res.status(500).json({ error: error.message || 'Une erreur est survenue lors de l\'initiation du paiement' });
  }
});

// Check status via Fapshi
router.get("/payment-status/:reference", async (req, res) => {
  const { reference } = req.params;
  const { provider, gatewayRef } = req.query; 

  console.log(`[Netlify Fapshi] Checking status for ${reference} (gatewayRef: ${gatewayRef})`);

  try {
    let currentStatus = 'pending';
    let failReason = '';
    
    // Check webhook cache
    const hookData = webhookCache.get(gatewayRef as string) || webhookCache.get(reference);
    if (hookData) {
      const hookStatus = String(hookData.status || hookData.state || hookData.event || '').toUpperCase();
      if (['SUCCESS', 'SUCCESSFUL', 'COMPLETED', 'PAID'].includes(hookStatus)) {
        currentStatus = 'success';
      } else if (['FAILED', 'EXPIRED', 'CANCELED', 'CANCELLED'].includes(hookStatus)) {
        currentStatus = 'failed';
        let hMsg = hookData.message || hookData.reason || 'solde insuffisant';
        if (typeof hMsg === 'object') {
          try { hMsg = JSON.stringify(hMsg); } catch(e) {}
        }
        failReason = String(hMsg || 'solde insuffisant');
      }
    } else {
      // Query Fapshi API directly
      const targetRef = (gatewayRef || reference) as string;
      if (targetRef) {
        try {
          const statusResponse = await fetch(`https://live.fapshi.com/payment-status/${targetRef}`, {
            headers: {
              "apiuser": FAPSHI_API_USER,
              "apikey": FAPSHI_API_KEY
            }
          });

          if (statusResponse.ok) {
            const statusData = await statusResponse.json();
            console.log(`[Netlify Fapshi] Status response:`, statusData);
            const rawStatus = String(statusData?.status || '').toUpperCase();
            
            if (['SUCCESSFUL', 'SUCCESS', 'COMPLETED', 'PAID'].includes(rawStatus)) {
              currentStatus = 'success';
            } else if (['FAILED', 'EXPIRED', 'CANCELLED', 'CANCELED'].includes(rawStatus)) {
              currentStatus = 'failed';
              let fMsg = statusData?.reason || statusData?.message || (rawStatus === 'EXPIRED' ? 'Session de paiement expirée' : 'solde insuffisant');
              if (typeof fMsg === 'object') {
                try { fMsg = JSON.stringify(fMsg); } catch(e) {}
              }
              failReason = String(fMsg || 'solde insuffisant');
            } else {
              currentStatus = 'pending';
            }
          }
        } catch (apiError) {
          console.warn("[Netlify Fapshi] Status check error:", apiError);
        }
      }
    }

    res.status(200).json({ status: currentStatus, reason: failReason, transaction: { reference, gatewayRef } });
  } catch (error: any) {
    console.error("[Netlify Fapshi] Status check error:", error);
    res.status(500).json({ error: error.message || 'Erreur statut' });
  }
});

// Webhook endpoints
router.post("/payment-webhook", async (req, res) => {
  console.log("[Netlify Webhook] POST received:", req.body);
  const { reference, status, event, transactionId, id, state, transId } = req.body;
  const refKey = reference || transId || transactionId || id || event;
  if (refKey) {
    webhookCache.set(refKey, req.body);
  }
  res.status(200).json({ received: true });
});

router.get("/payment-webhook", async (req, res) => {
  console.log("[Netlify Webhook] GET received:", req.query);
  const { reference, status, event, transactionId, id, state, transId } = req.query;
  const refKey = reference || transId || transactionId || id || event;
  if (refKey) {
    webhookCache.set(refKey as string, req.query);
  }
  res.status(200).json({ received: true });
});

app.use("/api", router);
app.use("/", router);

export const handler = serverless(app);
