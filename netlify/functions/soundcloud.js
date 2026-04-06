exports.handler = async function(event) {

  const CLIENT_ID     = 'PzE31xlhlPQjpIhAP4bj74lDWJbrTnID';
  const CLIENT_SECRET = 'RyReqpCCfhHYJbKa1JmkgwVx6GV1j3mC';
  const USERNAME      = 'nurinstitute';
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const query = body.query || '';

    // ── STEP 1: Get SoundCloud OAuth token ──────────────────────────
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
      throw new Error(`SoundCloud token failed (${tokenResp.status}): ${err}`);
    }

    const { access_token } = await tokenResp.json();
    if (!access_token) throw new Error('No access token from SoundCloud');

    const scHeaders = {
      'Accept': 'application/json; charset=utf-8',
      'Authorization': `OAuth ${access_token}`
    };

    // ── STEP 2: Resolve user ─────────────────────────────────────────
    const userResp = await fetch(
      `https://api.soundcloud.com/resolve?url=https://soundcloud.com/${USERNAME}`,
      { headers: scHeaders }
    );
    if (!userResp.ok) throw new Error(`SoundCloud user not found (${userResp.status})`);
    const user = await userResp.json();

    // ── STEP 3: Fetch up to 200 tracks ──────────────────────────────
    let allTracks = [];
    let nextUrl = `https://api.soundcloud.com/users/${user.id}/tracks?limit=50&linked_partitioning=true`;

    for (let page = 0; page < 4 && nextUrl; page++) {
      const resp = await fetch(nextUrl, { headers: scHeaders });
      if (!resp.ok) break;
      const data = await resp.json();
      const items = data.collection || data;
      if (!Array.isArray(items) || items.length === 0) break;
      allTracks = allTracks.concat(items);
      nextUrl = data.next_href || null;
    }

    if (allTracks.length === 0) throw new Error('No public tracks found on SoundCloud account');

    // ── STEP 4: Keyword pre-filter ───────────────────────────────────
    const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = allTracks.map(t => {
      const hay = `${t.title} ${t.description || ''}`.toLowerCase();
      return { ...t, _score: keywords.length ? keywords.filter(k => hay.includes(k)).length : 1 };
    });
    const top15 = scored.sort((a, b) => b._score - a._score).slice(0, 15);

    // ── STEP 5: Claude AI ranking ────────────────────────────────────
    if (!ANTHROPIC_KEY) throw new Error('Anthropic API key not configured in Netlify environment variables');

    const list = top15.map((t, i) =>
      `${i+1}. Title: "${t.title}"\n   Description: "${(t.description||'').slice(0,200)}"\n   Duration: ${Math.round((t.duration||0)/60000)} min`
    ).join('\n\n');

    const prompt = `You are a knowledgeable assistant helping students of Sufism and Islamic spirituality find relevant lectures from Khanqah Imdadiyyah Ashrafiyyah.

A student is searching for: "${query}"

Here are ${top15.length} available lectures:
${list}

Return ONLY a valid JSON array, no markdown, no explanation. Include only genuinely relevant lectures ranked best first. For each include:
- index (1-based)
- relevance (0-100)
- reason (1-2 sentences why this lecture addresses the question)

Example: [{"index":1,"relevance":91,"reason":"This lecture directly covers..."}]`;

    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!aiResp.ok) {
      const err = await aiResp.json().catch(()=>({}));
      throw new Error(`AI ranking failed: ${err.error?.message || aiResp.status}`);
    }

    const aiData = await aiResp.json();
    const text = (aiData.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');

    let ranked;
    try {
      ranked = JSON.parse(text.replace(/```json|```/g,'').trim());
    } catch {
      ranked = top15.slice(0,5).map((_,i) => ({ index: i+1, relevance: 70, reason: 'Keyword match found.' }));
    }

    const results = ranked
      .filter(r => r.relevance > 25)
      .map(r => {
        const t = top15[r.index - 1];
        if (!t) return null;
        return {
          title:         t.title || '',
          description:   t.description || '',
          duration:      t.duration || 0,
          permalink_url: t.permalink_url || '',
          playback_count: t.playback_count || 0,
          relevance:     r.relevance,
          reason:        r.reason
        };
      })
      .filter(Boolean);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ results })
    };

  } catch (err) {
    console.error('Function error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
