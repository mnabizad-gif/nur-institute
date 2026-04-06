exports.handler = async function(event) {

  const CLIENT_ID     = 'PzE31xlhlPQjpIhAP4bj74lDWJbrTnID';
  const CLIENT_SECRET = 'RyReqpCCfhHYJbKa1JmkgwVx6GV1j3mC';
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  // Your 3 playlists
  const PLAYLISTS = [
    { id: '1816185342', name: 'Jummah + Eid (2)' },
    { id: '88455109',   name: 'Jummah + Eid' },
    { id: '56160828',   name: 'General Programs (Saturday Majlis)' }
  ];

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const body  = event.body ? JSON.parse(event.body) : {};
    const query = (body.query || '').trim();

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

    // ── STEP 2: Fetch ALL tracks from all 3 playlists (paginated) ───
    const allTracksRaw = [];

    for (const playlist of PLAYLISTS) {
      try {
        // Paginate through all pages — max 200 per page, up to 10 pages
        let nextUrl = `https://api.soundcloud.com/playlists/${playlist.id}/tracks?limit=200&linked_partitioning=true`;
        let page = 0;

        while (nextUrl && page < 10) {
          const resp = await fetch(nextUrl, { headers: scHeaders });
          if (!resp.ok) break;

          const data = await resp.json();
          const items = data.collection || data;

          if (!Array.isArray(items) || items.length === 0) break;

          items.forEach(t => {
            allTracksRaw.push({ ...t, _playlist: playlist.name });
          });

          nextUrl = data.next_href || null;
          page++;
        }
      } catch (e) {
        console.error(`Failed to fetch playlist ${playlist.name}:`, e.message);
      }
    }

    // Deduplicate by track ID
    const seen = new Set();
    const allTracks = allTracksRaw.filter(t => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });

    if (allTracks.length === 0) throw new Error('No tracks found in your playlists. Make sure they are public.');

    // ── STEP 3: Keyword pre-filter — pick top 15 most relevant ──────
    const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = allTracks.map(t => {
      const hay = `${t.title} ${t.description || ''}`.toLowerCase();
      const score = keywords.length
        ? keywords.reduce((acc, k) => acc + (hay.includes(k) ? 1 : 0), 0)
        : 1;
      return { ...t, _score: score };
    });

    const top15 = scored
      .sort((a, b) => b._score - a._score)
      .slice(0, 15);

    // ── STEP 4: Claude AI ranking ────────────────────────────────────
    if (!ANTHROPIC_KEY) throw new Error('Anthropic API key not set in Netlify environment variables');

    const list = top15.map((t, i) =>
      `${i+1}. Title: "${t.title}"\n   Playlist: "${t._playlist}"\n   Description: "${(t.description||'').slice(0,200)}"\n   Duration: ${Math.round((t.duration||0)/60000)} min`
    ).join('\n\n');

    const prompt = `You are a knowledgeable assistant helping students of Sufism and Islamic spirituality find relevant lectures from Khanqah Imdadiyyah Ashrafiyyah.

A student is searching for: "${query}"

Here are ${top15.length} lectures from the library:
${list}

Return ONLY a valid JSON array — no markdown, no extra text. Include only genuinely relevant lectures ranked best first. If none are relevant return [].

For each include:
- index (1-based)
- relevance (0-100)
- reason (1-2 sentences why this lecture helps)

Example: [{"index":1,"relevance":91,"reason":"This lecture directly addresses..."}]`;

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
    const aiText = (aiData.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');

    let ranked;
    try {
      ranked = JSON.parse(aiText.replace(/```json|```/g,'').trim());
    } catch {
      ranked = top15.slice(0,5).map((_,i) => ({ index:i+1, relevance:70, reason:'Keyword match found.' }));
    }

    const results = ranked
      .filter(r => r.relevance > 25)
      .map(r => {
        const t = top15[r.index - 1];
        if (!t) return null;
        return {
          title:          t.title || '',
          description:    t.description || '',
          duration:       t.duration || 0,
          permalink_url:  t.permalink_url || '',
          playback_count: t.playback_count || 0,
          playlist:       t._playlist || '',
          relevance:      r.relevance,
          reason:         r.reason
        };
      })
      .filter(Boolean);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ results, total_searched: allTracks.length })
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
