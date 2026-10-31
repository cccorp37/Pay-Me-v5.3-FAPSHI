export default async function handler(req: any, res: any) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée. Utilisez POST.' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        body = {};
      }
    }

    const { phone, amount, currency, countryCode, email } = body || {};

    if (!phone || !amount || !currency) {
      return res.status(400).json({ error: 'Champs manquants (téléphone, montant ou devise)' });
    }

    // Sanitize phone
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
    }

    const transactionId = `TXN_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    const fapshiApiUser = (process.env.FAPSHI_API_USER || '7cad0afd-813d-41b7-b31f-7513a0ff3ceb').trim();
    const fapshiApiKey = (process.env.FAPSHI_API_KEY || 'FAK_4e86c70d587fe43b9328e4ae9a1dac0c').trim();

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

    console.log(`[VERCEL API] Direct-pay request to Fapshi for ${fapshiPhone}...`);

    const chargeRes = await fetch("https://live.fapshi.com/direct-pay", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apiuser": fapshiApiUser,
        "apikey": fapshiApiKey
      },
      body: JSON.stringify(payload)
    });

    if (!chargeRes.ok) {
      const errorText = await chargeRes.text();
      console.error(`[VERCEL API] Fapshi Error ${chargeRes.status}:`, errorText);
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

    return res.status(200).json({ reference: transactionId, payment });
  } catch (error: any) {
    console.error("[VERCEL API] Error in initiate-payment:", error);
    return res.status(500).json({ error: error.message || 'Erreur interne du serveur lors de l\'initiation du paiement' });
  }
}
