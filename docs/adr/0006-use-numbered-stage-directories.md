# Use numbered stage directories for YoinkIt runs

YoinkIt adopts clone-app-style numbered artifact stages for run directories, but maps them to YoinkIt's own workflow: Recon -> Static Map -> Motion Scout -> Map Report -> Map Gate -> Capture -> Spec -> Implement. This is worth recording because the existing prototype used looser map/plan/capture artifacts; the numbered shape makes stage ownership, evidence boundaries, and gate inputs explicit while preserving YoinkIt's split between measured static facts, motion candidates, real capture, and clean implementation.
