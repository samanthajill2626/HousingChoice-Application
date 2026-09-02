# S1 dependency proof adjudication

Date: 2026-09-02
Scope: Correct the planned workspace-audit expectation using the completed S1
dependency proof, without changing production behavior or dependency scope.

## Evidence

S1 installed exact dashboard `autolinker@4.1.5` with its only runtime dependency
`tslib@2.8.1`. Its clean Windows install, dashboard build, manifest inspection, and
disposable Linux ARM64 install/import proof passed. The installed manifests reported
MIT licensing, no preinstall/install/postinstall hooks, no optional dependencies,
and no native binary path.

The workspace production audit reported four existing high findings in `nanoid`,
`postcss`, `react-router`, and `react-router-dom`; it reported no Autolinker or
tslib finding. The human-provided isolated runtime audit for the selected graph was
zero vulnerabilities.

## Adjudication

The plan's prior expectation that a workspace-wide audit would exit zero is
superseded. It would incorrectly turn unrelated existing advisories into a blocker
for this exact dependency change. The S1 dependency proof requires recording and
baseline-attributing workspace audit findings, then blocks only advisories introduced
through the new `autolinker`/`tslib` graph. No remediation outside that graph belongs
to this mission.
