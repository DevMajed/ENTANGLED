# Validation

## Executed checks

The completed application was tested on October 3, 2026 with Node.js 24.16.0, Vite 7.3.6 and Three.js 0.180.0.

- **74 automated tests passed; 0 failed and 0 skipped.**
- **Production build passed.**
- The running application was operated at **1280×720, 1440×900 and 1920×1080**.

Run `npm test` and `npm run build` to reproduce the automated checks.

## What the tests cover

| Area | Checks |
| --- | --- |
| Quantum probabilities | Normalization, positivity, specified angle cases, 50/50 local marginals, analytical/Born-projector agreement and ordinary-source comparison |
| Coherent optics | Half-wave plate convention, PBS isometry, relative phases, norm preservation and the distinction between the full state and polarization with path traced out |
| Measurement records | Two detector events per ideal pair, immutable captured settings/times, independent outcome and timing random streams, commit deduplication and separate run groups |
| Timing | Channel/timestamp-only matching, the inclusive full-width window, delay, ambiguity and unmatched-event reporting |
| Playback | Pause, SPAD micro-events, first destructive absorption, later readouts, seek, replay, loop, speed and rendering-frame invariance |
| Large batches | Actual worker-message handling with 100,000 records and 200,000 detector events retained |
| Panels and exports | Geometry, persistence, docking, locking, visibility, explicit units, detached snapshots and shared-state serialization |

Some retained tests exercise internal mathematical/legacy APIs outside the current presentation. Scene tests use lightweight renderer stubs; they check behavior contracts rather than claiming GPU screenshot coverage. Seeded frequency tests use stated statistical tolerances rather than demanding exact 50/50 samples.

## Observations in the running browser

The complete 86-second guided presentation reached its final chapter at 8× and committed exactly one pair. PBS inspection before detection showed coherent paths without prematurely displaying a detector outcome. The prepared H/V/D component inspector returned to the same paused pair and camera context. SPAD micro-steps showed absorption, acceleration, avalanche, pulse and quench/recovery.

All 15 panels were dragged and resized. A moved, resized and locked caption kept its placement across a stage change and reload. H hid and restored overlays. Panel drag and text scroll did not move the camera. Manual orbit released guided camera control. Edited captions persisted; the option to keep physics running under a held caption worked. A saved visible second-arm inset rendered after reload.

An actual 100,000-pair batch completed while the presentation-speed control remained responsive. Together with the preceding demonstration, it produced 100,001 matched observations at 0°/0°: `++=0`, `+−=50,333`, `−+=49,668`, `−−=0`, `E=−1.000`. The displayed worker computation time was 1.15 seconds on the test machine; this excludes transfer, recording and rendering.

Fresh 1,000-pair runs were kept separate:

| Source / bases | Observed result |
| --- | --- |
| Singlet 45° / 45° | 501 / 499 opposite outputs; E=−1.000 |
| Singlet 0° / 45° | Four bins 247 / 236 / 260 / 257; E=0.008 |
| Ordinary mixture 45° / 45° | E=−0.004 |

Replay and scrubbing left the 100,001 live total unchanged. A separate final 100-pair batch plus its demonstration had 101 records; inspecting a sampled batch pair and seeking to the end retained the same total and counts. No browser error or warning logs were captured in that final check.

## Limits of verification

Native fullscreen did not activate in the embedded test browser, and an actual JSON save-to-disk could not be confirmed there. The standard fullscreen/download actions are implemented; export data and serialization passed automated checks.

No sustained FPS benchmark or cross-browser/GPU certification was performed. The semiconductor, source and coating interiors are explanatory schematics, not numerical device simulations. These results validate the educational software model, not a physical entanglement experiment.
