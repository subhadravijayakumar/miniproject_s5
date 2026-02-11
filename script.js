 // script.js

const searchBtn = document.getElementById('searchBtn');
const placeInput = document.getElementById('placeInput');
const resultsDiv = document.getElementById('results');
const statusP = document.getElementById('status');

searchBtn.addEventListener('click', searchHospitals);
placeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') searchHospitals(); });

/** small helper: pause */
const wait = ms => new Promise(r => setTimeout(r, ms));

/** Haversine distance in km */
function haversine(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

/** Try multiple URLs & return parsed JSON, throwing helpful errors when necessary */
async function tryFetchJson(urls, opts = {}, tries = 3) {
  let lastErr = null;
  for (const url of urls) {
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        const res = await fetch(url, opts);
        const text = await res.text();
        // quick attempt to parse JSON (some Overpass servers sometimes return HTML)
        try {
          const data = JSON.parse(text);
          if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText}`);
          }
          return { data, url };
        } catch (parseErr) {
          // not valid JSON -> probably an HTML error page; include first chars
          throw new Error(`Non-JSON response from ${url} (status ${res.status}) — first chars: ${text.slice(0,180)}`);
        }
      } catch (err) {
        lastErr = err;
        // if server tells us to wait (429), backoff a bit
        const backoff = 500 * Math.pow(2, attempt);
        await wait(backoff);
      }
    }
  }
  throw lastErr || new Error('All fetch attempts failed');
}

async function searchHospitals() {
  const place = (placeInput.value || '').trim();
  resultsDiv.innerHTML = '';
  statusP.textContent = '';

  if (!place) {
    statusP.textContent = 'Please type or select a tourist place.';
    return;
  }

  statusP.textContent = 'Geocoding place...';
  try {
    // Try Nominatim first, then geocode.maps.co as fallback
    const geoEndpoints = [
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(place + ', Tamil Nadu, India')}`,
      `https://geocode.maps.co/search?q=${encodeURIComponent(place + ', Tamil Nadu, India')}&limit=1`
    ];

    const { data: geoData } = await tryFetchJson(geoEndpoints, { headers: { 'Accept': 'application/json' } }, 2);

    if (!Array.isArray(geoData) || geoData.length === 0) {
      statusP.textContent = 'Place not found. Try a nearby city or check spelling.';
      return;
    }

    const lat = parseFloat(geoData[0].lat);
    const lon = parseFloat(geoData[0].lon);
    statusP.textContent = `Searching hospitals around ${place} (lat ${lat.toFixed(4)}, lon ${lon.toFixed(4)})...`;

    // radius in meters - increase for small towns (change if you want)
    const radius = 15000; // 15 km

    // Overpass query: nodes, ways, relations; hospitals & clinics
    const overpassQuery = `
      [out:json][timeout:30];
      (
        node["amenity"="hospital"](around:${radius},${lat},${lon});
        way["amenity"="hospital"](around:${radius},${lat},${lon});
        relation["amenity"="hospital"](around:${radius},${lat},${lon});
        node["amenity"="clinic"](around:${radius},${lat},${lon});
        way["amenity"="clinic"](around:${radius},${lat},${lon});
        relation["amenity"="clinic"](around:${radius},${lat},${lon});
      );
      out center;
    `.trim();

    const encoded = encodeURIComponent(overpassQuery);
    const overpassUrls = [
      `https://overpass-api.de/api/interpreter?data=${encoded}`,
      `https://overpass.kumi.systems/api/interpreter?data=${encoded}`
    ];

    let hospitalJson;
    try {
      const fetchRes = await tryFetchJson(overpassUrls, { method: 'GET' }, 3);
      hospitalJson = fetchRes.data;
      console.log('Overpass used:', fetchRes.url);
    } catch (err) {
      console.error('Overpass failed:', err);
      statusP.textContent = 'Failed to fetch hospital data (server busy or rate-limited). Try again in a moment.';
      return;
    }

    const elements = hospitalJson.elements || [];
    if (elements.length === 0) {
      statusP.textContent = `No hospitals/clinics found within ${radius/1000} km of ${place}.`;
      return;
    }

    // Build list with distances
    const items = elements.map(el => {
      const lat2 = (el.lat !== undefined) ? el.lat : (el.center && el.center.lat);
      const lon2 = (el.lon !== undefined) ? el.lon : (el.center && el.center.lon);
      return {
        el,
        lat2: parseFloat(lat2),
        lon2: parseFloat(lon2)
      };
    }).filter(i => !Number.isNaN(i.lat2) && !Number.isNaN(i.lon2));

    // compute distances and sort
    items.forEach(i => i.distance = haversine(lat, lon, i.lat2, i.lon2));
    items.sort((a,b) => a.distance - b.distance);

    // limit how many to show (avoid too many cards)
    const toShow = items.slice(0, 30);

    resultsDiv.innerHTML = '';
    statusP.textContent = `Found ${elements.length} items; showing nearest ${toShow.length}.`;

    for (const it of toShow) {
      const el = it.el;
      const tags = el.tags || {};
      const name = tags.name || tags['ref'] || 'Unnamed Hospital/Clinic';
      const lat2 = it.lat2;
      const lon2 = it.lon2;
      const distance = it.distance.toFixed(2);

      // build address
      const addrParts = [];
      ['addr:housename','addr:housenumber','addr:street','addr:city','addr:state','addr:postcode'].forEach(k => {
        if (tags[k]) addrParts.push(tags[k]);
      });
      const address = addrParts.join(', ') || (tags['address'] || 'Address not available');

      const phone = tags.phone || tags['contact:phone'] || tags['telephone'] || null;
      const website = tags.website || tags['contact:website'] || null;
      const opening = tags.opening_hours || tags['opening_hours'] || null;

      const mapImg = `https://staticmap.openstreetmap.de/staticmap.php?center=${lat2},${lon2}&zoom=15&size=400x200&markers=${lat2},${lon2},red-pushpin`;

      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <img src="${mapImg}" alt="${name}">
        <h3>${escapeHtml(name)}</h3>
        <p class="meta">Distance: <strong>${distance} km</strong></p>
        <p>${escapeHtml(address)}</p>
        ${opening ? `<p>Hours: ${escapeHtml(opening)}</p>` : ''}
        <div class="meta">
          ${phone ? `<a class="link" href="tel:${encodeURI(phone)}">📞 ${escapeHtml(phone)}</a>` : ''}
          ${website ? `<a class="link" href="${escapeHtmlAttr(website)}" target="_blank" rel="noopener">🔗 Website</a>` : ''}
          <a class="link" href="https://www.openstreetmap.org/?mlat=${lat2}&mlon=${lon2}#map=18/${lat2}/${lon2}" target="_blank" rel="noopener">View on OSM</a>
        </div>
      `;
      resultsDiv.appendChild(card);
    }

  } catch (err) {
    console.error(err);
    statusP.textContent = 'An error occurred while searching. See console for details.';
  }
}

/** basic escape helpers for safety when injecting into innerHTML */
function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}
function escapeHtmlAttr(s) {
  return escapeHtml(s).replace(/"/g, '%22');
}