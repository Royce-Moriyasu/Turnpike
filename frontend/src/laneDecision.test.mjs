import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'vite';

const bundle = await build({ configFile: false, logLevel: 'silent', build: {
  write: false, lib: { entry: 'src/laneDecision.ts', formats: ['es'] }, minify: false,
} });
const { laneDecision } = await import(`data:text/javascript;base64,${Buffer.from(bundle[0].output[0].code).toString('base64')}`);
const route = JSON.parse(await readFile('public/demo_route.json', 'utf8'));
const emptyVision = { source: 'labeled', label: 'Labeled', polygons: null, confidence: 0 };
const approach = route.frames.findIndex(f => f.id === '155484140237039');
const decided = laneDecision(route.frames, approach, 'north', emptyVision);
assert.equal(decided.lanes.length, 5, 'nearby five-lane ramp state survives a premature Mapbox count drop');
assert.equal(decided.preferredLane, 3, 'lane 4 remains the route target');
const afterTurn = laneDecision(route.frames, approach + 1, 'north', emptyVision);
assert.equal(afterTurn.lanes.length, 2, 'new maneuver resets the lane decision');

const current = { instruction: 'Take ramp', maneuverType: 'on ramp', modifier: 'right', progressM: 0,
  lanes: [{valid:true, indications:['straight']}, {valid:true, indications:['straight']}], preferredLane: 0, laneSide: 'right' };
const future = { ...current, lanes: Array.from({length: 5}, () => ({valid:true, indications:['straight']})), preferredLane: 3 };
const frames = [
  {progressM: 0, nav: {north: current}},
  {progressM: 15, nav: {north: future}},
];
const fromFuture = laneDecision(frames, 0, 'north', emptyVision);
assert.equal(fromFuture.lanes.length, 5);
assert.equal(fromFuture.preferredLane, 3);
const polys = Array.from({length: 7}, (_, i) => [[i, 1], [i + 0.9, 1], [i + 0.9, 0.8], [i, 0.8]]);
const expanded = laneDecision(frames, 0, 'north', { ...emptyVision, polygons: polys, confidence: 0.8 });
assert.equal(expanded.lanes.length, 7);
assert.equal(expanded.preferredLane, 5, 'extra visible lanes on the left shift the absolute target');
const laneBundle = await build({ configFile: false, logLevel: 'silent', build: {
  write: false, lib: { entry: 'src/lanes.ts', formats: ['es'] }, minify: false,
} });
const { laneTarget } = await import(`data:text/javascript;base64,${Buffer.from(laneBundle[0].output[0].code).toString('base64')}`);
const first = route.frames[0];
const firstVision = { source: 'yolop', label: 'YOLOPv2', ...first.laneSets.yolop };
const firstNav = laneDecision(route.frames, 0, 'north', firstVision);
const firstTarget = laneTarget(firstNav.preferredLane, firstNav.lanes.length, firstVision.polygons, firstNav.laneSide, true);
assert.equal(firstTarget.index, 1, 'first frame must target the car lane beside the bike lane');
assert.ok(firstTarget.excluded.has(2), 'narrow rightmost YOLOPv2 polygon is a bike lane');
const noDetection = laneDecision(route.frames, 24, 'north', { source: 'yolop', label: 'YOLOPv2', polygons: null, confidence: 0 });
assert.equal(noDetection.preferredLane, null, 'missing YOLOPv2 geometry cannot become a lane recommendation');
const oneWrongLane = laneDecision(route.frames, 26, 'north', { source: 'yolop', label: 'YOLOPv2', ...route.frames[26].laneSets.yolop });
assert.equal(oneWrongLane.preferredLane, null, 'do not route to a lane outside the detected YOLOPv2 polygons');
console.log('Lane decision checks passed');
