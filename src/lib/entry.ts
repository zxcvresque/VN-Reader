const ENTRY_KEY = "vn-reader-entry-v1";
const TOUR_KEY = "vn-reader-basic-tour-v2";

export function shouldOfferTour(): boolean {
  try { return localStorage.getItem(TOUR_KEY) !== "seen"; }
  catch { return true; }
}

export function rememberTourInvitation(): void {
  try { localStorage.setItem(TOUR_KEY, "seen"); }
  catch { /* The reader still works without device storage. */ }
}

/** Guest entry is a device preference, never an authenticated session. */
export function hasEnteredAsGuest(): boolean {
  try { return localStorage.getItem(ENTRY_KEY) === "guest"; }
  catch { return false; }
}

export function rememberGuestEntry(): void {
  try { localStorage.setItem(ENTRY_KEY, "guest"); }
  catch { /* Guest reading also works when browser storage is unavailable. */ }
}
