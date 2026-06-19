export default async function handler(req, res) {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: "No code" });

  const response = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
    }),
  });

  const data = await response.json();
  if (!response.ok) return res.status(400).json({ error: data });

  const { access_token, refresh_token, expires_at, athlete } = data;
  const params = new URLSearchParams({
    access_token,
    refresh_token,
    expires_at,
    athlete_id: athlete.id,
    athlete_name: athlete.firstname,
  });

  res.redirect(`/?${params.toString()}`);
}
