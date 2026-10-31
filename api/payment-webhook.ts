export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  console.log("🔥 [VERCEL WEBHOOK] received:", req.body || req.query);
  return res.status(200).json({ received: true });
}
