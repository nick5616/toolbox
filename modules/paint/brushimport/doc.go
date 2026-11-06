// Package brushimport reads brush files made for other painting apps
// (Procreate .brushset/.brush, MyPaint .myb, Photoshop .abr sampled tips,
// Krita .bundle) into Paint+ brush JSON + PNG tips and grains (Phase 19,
// SPEC.md §1.3.2, §2.4). B1 implements it. It reads only PNG, plist and
// JSON data: zip entries are size-capped and path-sanitised.
package brushimport
