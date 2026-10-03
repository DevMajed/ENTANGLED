# How ENTANGLED works

ENTANGLED follows one photon pair through a quantum-optics experiment. You can
stop inside a wave plate, explore the coated interface of a beam splitter, and
watch a photon become an electrical detector pulse. After the photons have been
absorbed, their records remain. Repeating the experiment lets a pattern emerge
from individually unpredictable outcomes.

The apparatus and its records share one model. The camera tells the story;
moving it does not change the experiment. This is an educational quantum-model
simulation, not data from physical laboratory hardware.

## Follow the experiment

The source prepares a polarization-entangled pair, sending one photon to
Alice's station and one to Bob's. Each station has a half-wave plate, a fixed
polarizing beam-splitter cube (PBS), and two single-photon avalanche detectors
(SPADs). The four detector channels feed a time tagger.

The wave plate sets the measurement basis. The PBS coherently directs the two
orthogonal polarization components into different output paths. A SPAD absorbs
the photon, amplifies the resulting charge into an electrical pulse, and
produces a timing record. In the ideal pair model, exactly one detector on each
arm registers an event.

Before absorption, the visible branches represent amplitudes. They are not
separate photon copies or half-energy photons. Wavepacket colors distinguish
the arms; they do not represent different energies. Source interiors, coating
layers and semiconductor carriers are enlarged explanatory schematics.

The isolated PBS inspector offers prepared H, V and D inputs. It is a separate
single-photon example and contributes no counts to the pair experiment. An
unmeasured member of the entangled pair is not individually a prepared D photon.

## Why random outcomes form a pattern

The default joint state is the singlet:

$$
|\psi^-\rangle = \frac{|H\rangle_A|V\rangle_B-|V\rangle_A|H\rangle_B}{\sqrt{2}}.
$$

The relative minus sign distinguishes a coherent joint state from an ordinary
mixture of H/V and V/H assignments. Each photon alone has polarization state
$I/2$: either local outcome has probability one half. The model does not give
each emitted quantum photon a hidden definite polarization and then apply
independent classical coin flips.

For effective analyzer angles $a,b$, the positive basis state is
$|+a\rangle=\cos(a)|H\rangle+\sin(a)|V\rangle$; the negative state is its
orthogonal partner. Outcomes $s,t$ take values $+1,-1$, with joint probability

$$
P(s,t\mid a,b)=\frac{1-st\cos(2(a-b))}{4},\qquad E(a,b)=-\cos(2(a-b)).
$$

The UI uses degrees. The model converts angles for trigonometric calculations.

| Alice / Bob basis | Ideal result |
| --- | --- |
| 0° / 0° | Always opposite; $E=-1$ |
| 45° / 45° | Always opposite; $E=-1$ |
| 0° / 45° | Four equally likely joint outcomes; $E=0$ |
| 0° / 90° | Always the same; $E=+1$ |

The ordinary correlated comparison source is
$\rho_{mix}=(|HV\rangle\langle HV|+|VH\rangle\langle VH|)/2$. It has
$E_{mix}=-\cos(2a)\cos(2b)$: opposite H/V outcomes, but no such pattern at
matching 45° bases. This is one separable correlated source, rather than a model
of every possible classical theory. A correlation measured in one basis alone
does not establish entanglement.

Observed correlation comes directly from completed counts:

$$
E_{observed}=\frac{N_{++}+N_{--}-N_{+-}-N_{-+}}{N}.
$$

Separate runs and captured settings have separate count groups. Empty groups
display unavailable values. Finite observations can fluctuate; the application
does not force counts to match the theory.

## What the wave plate and PBS actually do

The half-wave plate introduces a relative phase of $\pi$ between its principal
axes. With fast-axis angle $\theta$, the adopted Jones convention is

$$
U(\theta)=
\begin{bmatrix}\cos 2\theta&\sin 2\theta\\
\sin 2\theta&-\cos 2\theta\end{bmatrix}.
$$

Setting $\theta=a/2$ before the fixed H/V PBS implements effective analysis
at $a$. Thus a 22.5° plate setting implements 45° analysis. Detector labels
A+/A− and B+/B− refer to these input basis outcomes. H/V and D/A are aliases
at the appropriate angles, not labels valid for every incoming basis.

The ideal PBS operation is linear:

$$
|H,in\rangle\rightarrow|H,T\rangle,\qquad
|V,in\rangle\rightarrow e^{i\phi}|V,R\rangle.
$$

The default uses a zero compensated reflection phase. The implementation stores
complex amplitudes for the joint polarization-and-path state. At matching 0°
bases, its displayed convention gives

$$
\frac{|H,T\rangle_A|V,R\rangle_B-|V,R\rangle_A|H,T\rangle_B}{\sqrt{2}}.
$$

Local lossless optics preserve the coherence of the full state. Ignoring the
path degrees of freedom can remove coherence from the polarization-only
description. This is different from a detector making an irreversible record.

The SPAD sequence illustrates absorption, carrier acceleration, impact
ionization, pulse generation and quenching. The model treats absorption and
irreversible amplification as destructive measurement. After the first
absorption, the original pair is unavailable as two entangled photons. A later
screen update, audible click or observer is not what causes the measurement.
The animation does not claim to locate a universally agreed microscopic instant
of collapse.

## Timing and pairing the records

Absorption times and later electronic readout times are distinct. Optical
flight is calculated from path length and the speed of light. Readout latency,
a configurable relative delay and optional Gaussian timestamp jitter are
represented explicitly. Named `*Ns` fields use nanoseconds; the export also
identifies the few aliases expressed in seconds.

Coincidence matching uses observed channels and timestamps. For total window
width $W$ centered on calibrated offset $\Delta_0$, a candidate must satisfy

$$
|(t_B-t_A)-\Delta_0|\leq W/2.
$$

The matcher accepts only mutually unique candidates. Ambiguous, unmatched and
invalid events are reported. Simulator pair IDs exist for checking records but
do not choose matches. Completed truth-paired counts and timestamp-matched
results are distinct outputs. With zero jitter, timing has a sharp feature;
the application does not invent a smooth measured-looking peak. A timing
coincidence peak alone does not demonstrate polarization entanglement.

## Playback without changing the result

A measurement record captures its settings, outcomes, detector events, timing,
seed, run ID and unique commit ID. The record is immutable. Software samples
the joint event once before playback, while the presentation conceals its
outcomes until absorption. This storage choice is not a physical claim about
predetermined values at emission.

Outcome sampling and timestamp jitter use independent seeded pseudorandom
streams. Changing delay or jitter therefore cannot change the polarization
sample. The generator is reproducible, not a source of true quantum randomness
or cryptographic entropy.

The director derives the current stage and micro-event from one seekable
timeline. Pause, slow motion, scrubbing and replay inspect the same stored
event. Presentation time never rescales the physical timestamps. Camera order
is storytelling order: inspecting Alice does not postpone Bob's physical
detection. A unique commit ID prevents replay from counting the pair twice.
New settings apply to a fresh pair; old records retain their original settings.

## Code architecture

The application uses vanilla JavaScript modules, Vite and Three.js. Three.js
renders procedural geometry with WebGL: optical mounts, prism halves, coating
planes, detector layers, carriers and circuit elements. The scene is interactive
geometry rather than prerecorded video.

| Module | Responsibility |
| --- | --- |
| [`physics.js`](../src/physics.js) | Born probabilities, complex density-matrix reference, projectors and seeded sampling; no rendering imports. |
| [`measurement.js`](../src/measurement.js) | Coherent PBS state, immutable detector events, timing matcher and deduplicated statistics store. |
| [`stages.js`](../src/stages.js) | Structured chapter text, targets, cutaways and micro-events. |
| [`director.js`](../src/director.js) | Deterministic timeline, seek, pause, stage navigation and replay. |
| [`lab-scene.js`](../src/lab-scene.js) | Procedural optics, cutaways, camera control and rendering of model snapshots. |
| [`panels.js`](../src/panels.js) | Movable, resizable and persistent screen-space panels. |
| [`measurement-worker.js`](../src/measurement-worker.js) | Large fresh-pair batches outside the main UI thread, with progress reporting. |
| [`export.js`](../src/export.js) | Portable records with explicit units, seeds and shared group context. |
| [`main.js`](../src/main.js) | Connects controls, presentation, scene and authoritative store. |

Batches compute every requested pair without creating a mesh or DOM row for
each photon. Shared settings and coherent-state data reduce repeated storage;
the interface shows bounded logs and can inspect an actual sampled batch event.
Panel positions, captions and presentation preferences are saved in browser
storage separately from the physics. Moving a panel changes the layout, not
the optical settings or recorded outcome.

The scope remains an ideal educational model: complete single-pair detection,
specified polarization states and optional timestamp error. It does not solve
source engineering, optical coating design, electromagnetic fields or
semiconductor dynamics, and it does not constitute experimental proof.
