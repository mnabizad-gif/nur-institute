exports.handler = async function(event) {

  // ── YOUR SOUNDCLOUD CREDENTIALS ──────────────────────────────────
  const CLIENT_ID     = 'PzE31xlhlPQjpIhAP4bj74lDWJbrTnID';
  const CLIENT_SECRET = 'RyReqpCCfhHYJbKa1JmkgwVx6GV1j3mC';
  const USERNAME      = 'nurinstitute';
  // ─────────────────────────────────────────────────────────────────

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    // STEP 1: Get OAuth access token via Client Credentials flow
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

    const tokenResp = await fetch('https://secure.soundcloud.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json; charset=utf-8',
        'Authorization': `Basic ${credentials}`
      },
      body: 'grant_type=client_credentials'
    });

    if (!tokenResp.ok) {
      const err = await tokenResp.text();
      throw new Error(`Token request failed (${tokenResp.status}): ${err}`);
    }

    const tokenData = await tokenResp.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) throw new Error('No access token returned from SoundCloud.');

    const authHeader = {
      'Accept': 'application/json; charset=utf-8',
      'Authorization': `OAuth ${accessToken}`
    };

    // STEP 2: Resolve username to user object
    const userResp = await fetch(
      `https://api.soundcloud.com/resolve?url=https://soundcloud.com/${USERNAME}`,
      { headers: authHeader }
    );
    if (!userResp.ok) throw new Error(`Could not find SoundCloud user (${userResp.status})`);
    const user = await userResp.json();

    // STEP 3: Paginate through tracks (up to 200)
    let allTracks = [];
    let nextUrl = `https://api.soundcloud.com/users/${user.id}/tracks?limit=50&linked_partitioning=true`;

    for (let page = 0; page < 4 && nextUrl; page++) {
      const resp = await fetch(nextUrl, { headers: authHeader });
      if (!resp.ok) break;
      const data = await resp.json();
      const items = data.collection || data;
      if (!Array.isArray(items) || items.length === 0) break;
      allTracks = allTracks.concat(items);
      nextUrl = data.next_href || null;
    }

    // STEP 4: Return only the fields the front end needs
    const tracks = allTracks.map(t => ({
      id:             t.id,
      title:          t.title || '',
      description:    t.description || '',
      duration:       t.duration || 0,
      genre:          t.genre || '',
      playback_count: t.playback_count || 0,
      permalink_url:  t.permalink_url || ''
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ tracks, total: tracks.length })
    };

  } catch (err) {
    console.error('SoundCloud function error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
