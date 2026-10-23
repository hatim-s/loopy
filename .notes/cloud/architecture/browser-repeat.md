# Architecture dashboard acceptance

Personal Chrome profile Hatim connected to the generated architecture credential at http://127.0.0.1:15272 after performance captures ended. The credential was read only into the browser tool and was not printed. The root-created tab 2090906341 was closed after inspection; existing user tabs were untouched.

The overview visibly showed 528 runs, 64 failures, 87.9% success, zero awaiting runs and zero active workers out of four. The catalog displayed all 15 definitions, descriptions, retained run totals and recent outcomes. The two burst workflows each showed 101 retained runs including their preflight; the migration workflow showed 26 including its preflight.

The selected retry run a3ee20d9-7d20-4022-aeb1-e541a98a5472 showed the pinned revision 803bf3d2, succeeded outcome, finished receipt and expected output. Its attempt history showed the controlled execution failure on attempt one and success on attempt two. This is a representative browser check; exhaustive retry and scoped-node evidence comes from the stopped database census.

Screenshots are retained in `.notes/cloud/evidence/architecture/dashboard-populated.png`, `dashboard-loopies.png` and `dashboard-retry-attempts.png`. The overview screenshot was also visually inspected. No workflow mutation, approval, run-again action or schedule change was made during browser QA.

The browser console showed no captured errors and one React Flow attribution warning. This record does not establish an exhaustive browser compatibility or accessibility audit. API timing captures exclude this QA traffic.
