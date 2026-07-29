import { useEffect, useState } from 'react';

// =====================================================================
// useCompactLayout — "is there room for the two-column desktop layout?"
//
// WIDTH IS NOT ENOUGH, and that was the landscape bug. ChatShell and
// StatusFooter each tested `window.innerWidth <= 800` independently. Turn a
// phone sideways and it reports something like 844x390 or 926x428: WIDER than
// the 800px threshold, so both switched to the desktop layout — on a viewport
// barely 400px tall. The sidebar, header, message pane, composer and footer
// then have to share ~400px of height, so the app "stays in portrait" from the
// user's point of view and most of it is off-screen or unreachable.
//
// A landscape phone is short, not wide. So compact means EITHER dimension is
// small, and 500px of height is the discriminator: landscape phones sit at
// 320-430, while a desktop browser window is essentially never that short.
//
// matchMedia rather than a resize handler on innerWidth: the browser evaluates
// the query itself, it fires on orientationchange without a separate listener,
// and it does not run React state updates on every intermediate resize pixel.
// One hook so the two components cannot disagree about what "mobile" means —
// they already had the same magic number copied twice.
// =====================================================================

export const COMPACT_QUERY = '(max-width: 800px), (max-height: 500px)';

export const useCompactLayout = () => {
  const [compact, setCompact] = useState(
    () => (typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(COMPACT_QUERY).matches
      : false),
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia(COMPACT_QUERY);
    const onChange = (e) => setCompact(e.matches);
    // addEventListener is the modern form; addListener is kept for older
    // WebKit, which is exactly the population most likely to be a phone.
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
    setCompact(mq.matches);          // resync in case it changed before mount
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, []);

  return compact;
};

export default useCompactLayout;
