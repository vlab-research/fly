import { useState, useEffect } from 'react';
import api from '../../services/api';

const POLL_INTERVAL_MS = 60000;

// Fetches survey health findings + platform notices, polling every 60s
// while mounted. Lives at SurveyScreen level so the Monitor tab badge works
// without entering the tab.
//
// `findings` is null until the first successful load (so consumers can
// avoid flashing "no issues" before data arrives); after that it stays on
// the last known good value — a failed poll must never blank the surface.
const useSurveyHealth = (surveyName) => {
  const [health, setHealth] = useState({ findings: null, notices: [] });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [healthRes, noticesRes] = await Promise.all([
          api.fetcher({ path: `/surveys/${encodeURIComponent(surveyName)}/health` }),
          api.fetcher({ path: '/platform/notices' }),
        ]);
        const healthData = await healthRes.json();
        const noticesData = await noticesRes.json();
        if (!cancelled) {
          setHealth({
            findings: healthData.findings || [],
            notices: noticesData.notices || [],
          });
        }
      } catch (err) {
        // Silent by default: health being unavailable must not break the
        // dashboard. Keep the last known state.
        console.error('Failed to load survey health', err);
      }
    };

    setHealth({ findings: null, notices: [] });
    load();
    const intervalId = setInterval(load, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [surveyName]);

  return health;
};

export default useSurveyHealth;
