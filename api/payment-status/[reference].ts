export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { reference, provider, gatewayRef } = req.query;

  try {
    let currentStatus = 'pending';
    let failReason = '';

    const targetRef = gatewayRef || reference;

    if (provider === 'fapshi' && targetRef) {
      const fapshiApiUser = (process.env.FAPSHI_API_USER || '7cad0afd-813d-41b7-b31f-7513a0ff3ceb').trim();
      const fapshiApiKey = (process.env.FAPSHI_API_KEY || 'FAK_4e86c70d587fe43b9328e4ae9a1dac0c').trim();

      const statusResponse = await fetch(`https://live.fapshi.com/payment-status/${targetRef}`, {
        headers: {
          "apiuser": fapshiApiUser,
          "apikey": fapshiApiKey
        }
      });

      if (statusResponse.ok) {
        const statusData = await statusResponse.json();
        const rawStatus = String(statusData?.status || '').toUpperCase();

        if (['SUCCESSFUL', 'SUCCESS', 'COMPLETED', 'PAID'].includes(rawStatus)) {
          currentStatus = 'success';
        } else if (['FAILED', 'EXPIRED', 'CANCELLED', 'CANCELED'].includes(rawStatus)) {
          currentStatus = 'failed';
          let fMsg = statusData?.reason || statusData?.message || (rawStatus === 'EXPIRED' ? 'Session de paiement expirée' : 'Paiement échoué');
          if (typeof fMsg === 'object') {
            try { fMsg = JSON.stringify(fMsg); } catch (e) {}
          }
          failReason = String(fMsg || 'solde insuffisant');
        } else {
          currentStatus = 'pending';
        }
      }
    }

    return res.status(200).json({
      status: currentStatus,
      reason: failReason,
      transaction: { reference, gatewayRef }
    });
  } catch (error: any) {
    console.error("[VERCEL API] Error in payment-status:", error);
    return res.status(500).json({ error: error.message || 'Erreur lors de la vérification du statut' });
  }
}
