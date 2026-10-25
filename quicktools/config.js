// Quick Tools remote - the ONE place the server's address is written (PLAN Section 38 D20).
// `exec` is the Quick Tools licence server's /exec address (the Apps Script web app). It is not a secret - every
// phone call carries its own session from the 6-digit email code - but it is filled in only at release time, with
// Yazeed's yes (docs\RELEASE-CHECKLIST.md, "Publish the phone page"). Blank = the page says it is not set up yet.
window.QT_CONFIG = {
  exec: "",
  version: "0.27.0-test"
};
