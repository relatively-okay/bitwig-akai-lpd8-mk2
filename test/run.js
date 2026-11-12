// Runs AkaiLPD8mk2.control.js against a mock Bitwig host and a fake LPD8 mk2.
// Usage: node test/run.js

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const SCRIPT_PATH = path.join(ROOT, "AkaiLPD8mk2.control.js");
const SCRIPT = fs.readFileSync(SCRIPT_PATH, "utf8");
const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8").trim();

const MK2_IDENTITY = fixture("mk2-identity.hex");
const MK2_PROGRAMS = [1, 2, 3, 4].map((n) => fixture(`mk2-factory-program${n}.hex`));

// First-generation LPD8 identity reply, from charlesfleche/lpd8editor doc/SYSEX.md.
const ORIGINAL_IDENTITY = "F0 7E 00 06 02 47 75 00 19 00 00 00 66 7F 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 F7";

const norm = (s) => s.replace(/\s+/g, " ").trim().toUpperCase();

// Bitwig passes SysEx to scripts as lowercase hex without spaces.
const toBitwigSysex = (s) => s.replace(/\s+/g, "").toLowerCase();

// --- Mock host --------------------------------------------------------------

function boot(device) {
	const events = [];
	let now = 0;
	let tasks = [];
	let midiCb, sysexCb;
	const observers = {};

	function schedule(fn, args, ms) { tasks.push({ at: now + ms, fn, args: args || [] }); }
	function advance(ms) {
		const end = now + ms;
		for (;;) {
			tasks.sort((a, b) => a.at - b.at);
			if (!tasks.length || tasks[0].at > end) break;
			const t = tasks.shift();
			now = t.at;
			t.fn.apply(null, t.args);
		}
		now = end;
	}

	const slots = (t) => ({
		setIndication() {},
		launch() { events.push(`launch T${t + 1}`); },
		addHasContentObserver(f) { observers[`content${t}`] = f; },
		addIsPlayingObserver(f) { observers[`playing${t}`] = f; },
		addIsQueuedObserver(f) { observers[`queued${t}`] = f; },
		addIsStopQueuedObserver(f) { observers[`stopping${t}`] = f; },
	});
	const tracks = [0, 1].map((t) => ({ s: slots(t), stop() { events.push(`stop T${t + 1}`); }, getClipLauncherSlots() { return this.s; } }));
	const controls = [];
	for (let i = 0; i < 64; i++) controls.push({ setLabel(l) { this.label = l; }, set(v, r) { events.push(`control ${i} = ${v}/${r}`); } });

	const host = {
		defineController() {}, defineMidiPorts() {}, addDeviceNameBasedDiscoveryPair() {},
		getMidiInPort: () => ({
			createNoteInput(...a) { events.push(`note input ${a.join(",")}`); },
			setMidiCallback(f) { midiCb = f; },
			setSysexCallback(f) { sysexCb = f; },
		}),
		getMidiOutPort: () => ({
			sendSysex(s) {
				events.push(`sysex out ${norm(s)}`);
				const reply = device && device(norm(s));
				if (reply) schedule(() => sysexCb(toBitwigSysex(reply)), [], 5);
			},
		}),
		createTrackBank: () => ({
			getTrack: (i) => tracks[i],
			launchScene() { events.push("launch scene"); },
			scrollScenesUp() { events.push("scene up"); },
			scrollScenesDown() { events.push("scene down"); },
			getClipLauncherScenes: () => ({ stop() { events.push("stop all"); } }),
		}),
		createUserControlsSection: () => ({ getControl: (i) => controls[i] }),
		scheduleTask: schedule,
		showPopupNotification(s) { events.push(`popup ${s}`); },
		println(s) { events.push(`log ${s}`); },
	};

	const ctx = { host, loadAPI() {}, println: (s) => events.push(`log ${s}`) };
	ctx.load = () => { throw new Error("script must not use load()"); };
	vm.createContext(ctx);
	vm.runInContext(SCRIPT, ctx, { filename: SCRIPT_PATH });
	ctx.init();

	return {
		events, observers, controls, advance,
		midi: (s, d1, d2) => midiCb(s, d1, d2),
		exit: () => ctx.exit(),
		take() { return events.splice(0); },
	};
}

function mk2Device(programs) {
	programs = programs || MK2_PROGRAMS;
	return (out) => {
		if (out === "F0 7E 7F 06 01 F7") return MK2_IDENTITY;
		const m = /^F0 47 7F 4C 03 00 01 0([1-4]) F7$/.exec(out);
		if (m) return programs[m[1] - 1];
		return null;
	};
}

const sysexOut = (events) => events.filter((e) => e.startsWith("sysex out "));
const colorSysex = (events) => sysexOut(events).filter((e) => e.startsWith("sysex out F0 47 7F 4C 06"));
const has = (events, re) => events.some((e) => re.test(e));

// --- Tests ------------------------------------------------------------------

const tests = {

	"script is a single plain-ASCII ES5 file without load()"() {
		assert.ok(!/[^\x09\x0a\x20-\x7e]/.test(SCRIPT), "non-ASCII, control or NUL characters found");
		assert.ok(!/\bload\s*\(/.test(SCRIPT), "load() makes the script depend on other files");
		assert.ok(!/=>|`|\b(let|const|class)\s/.test(SCRIPT), "ES2015+ syntax found");
		assert.deepStrictEqual(fs.readdirSync(ROOT).filter((f) => f.endsWith(".js")), ["AkaiLPD8mk2.control.js"]);
	},

	"mk2: identifies, reads all 4 programs read-only, maps factory layout"() {
		const t = boot(mk2Device());
		t.advance(2000);
		const out = sysexOut(t.events).map((e) => e.slice(10)).filter((s) => !s.startsWith("F0 47 7F 4C 06"));
		assert.deepStrictEqual(out, [
			"F0 7E 7F 06 01 F7",
			"F0 47 7F 4C 03 00 01 01 F7",
			"F0 47 7F 4C 03 00 01 02 F7",
			"F0 47 7F 4C 03 00 01 03 F7",
			"F0 47 7F 4C 03 00 01 04 F7",
		]);
		assert.ok(!has(t.events, /warning/), "identical factory programs must not warn");
		assert.ok(has(t.events, /popup LPD8 mk2 ready/));
		t.take();
		t.midi(0xb0, 70, 64);
		t.midi(0xb0, 77, 1);
		t.midi(0xb9, 12, 127);
		t.midi(0xb9, 12, 0);
		t.midi(0xb9, 19, 127);
		t.midi(0xc9, 2, 0);
		t.midi(0xb0, 70, 5);
		assert.deepStrictEqual(t.take(), [
			"control 0 = 64/128", "control 7 = 1/128", "stop T1", "scene up",
			"popup LPD8 mk2 knob bank 3", "control 16 = 5/128",
		]);
	},

	"mk2: custom program mapping is learned from the device"() {
		const custom = MK2_PROGRAMS.slice();
		const b = custom[0].split(" ");
		for (let k = 0; k < 8; k++) b[140 + 4 * k] = (0x15 + k).toString(16).toUpperCase(); // knobs CC 21-28
		custom[0] = b.join(" ");
		const t = boot(mk2Device(custom));
		t.advance(2000);
		t.take();
		t.midi(0xb0, 21, 99);
		t.midi(0xb0, 70, 1);
		assert.deepStrictEqual(t.take(), ["control 0 = 99/128", "control 0 = 1/128"]);
	},

	"mk2: factory mapping works before the handshake finishes"() {
		const t = boot(mk2Device());
		t.take();
		t.midi(0xb0, 71, 10);
		assert.deepStrictEqual(t.take(), ["control 1 = 10/128"]);
	},

	"mk2: pad colours are sent only once the controller is identified"() {
		const t = boot(mk2Device());
		assert.strictEqual(colorSysex(t.events).length, 0);
		t.advance(10);
		const colors = colorSysex(t.events);
		assert.ok(colors.length >= 1);
		assert.strictEqual(colors[colors.length - 1], "sysex out " + norm("F0 47 7F 4C 06 00 30 " +
			"00 3C 00 00 00 00  00 3C 00 00 00 00  00 3C 00 00 00 00  00 28 00 28 00 28 " +
			"00 00 00 00 00 00  00 00 00 00 00 00  00 00 00 3C 00 00  00 28 00 28 00 28 F7"));
	},

	"mk2: launch pad shows clip state and blinks while queued"() {
		const t = boot(mk2Device());
		t.advance(2000);
		t.observers.content0(0, true);
		t.observers.queued0(0, true);
		t.take();
		t.advance(BLINK_PERIOD * 2);
		const pad5 = colorSysex(t.take()).map((e) => e.split(" ").slice(9 + 4 * 6, 9 + 4 * 6 + 6).join(" "));
		assert.ok(pad5.includes("00 00 01 7F 00 00") && pad5.includes("00 00 00 00 00 00"), "pad 5 should blink green: " + pad5);
	},

	"mk2: exit turns the pads off"() {
		const t = boot(mk2Device());
		t.advance(2000);
		t.take();
		t.exit();
		assert.deepStrictEqual(colorSysex(t.take()).slice(-1), ["sysex out F0 47 7F 4C 06 00 30" + " 00".repeat(48) + " F7"]);
	},

	"original LPD8: says it is not supported and sends nothing else"() {
		const t = boot((out) => (out === "F0 7E 7F 06 01 F7" ? ORIGINAL_IDENTITY : null));
		t.advance(2000);
		assert.ok(has(t.events, /popup This is an original LPD8/));
		assert.deepStrictEqual(sysexOut(t.events), ["sysex out F0 7E 7F 06 01 F7"]);
	},

	"no reply: warns about the output port and keeps factory mapping"() {
		const t = boot(null);
		t.advance(2000);
		assert.ok(has(t.events, /popup .*check the controller's MIDI output port/));
		t.take();
		t.midi(0xb0, 70, 3);
		assert.deepStrictEqual(t.take(), ["control 0 = 3/128"]);
	},

	"unmapped CC is logged once with a hint"() {
		const t = boot(mk2Device());
		t.advance(2000);
		t.take();
		t.midi(0xb0, 1, 5);
		t.midi(0xb0, 1, 6);
		const logs = t.take().filter((e) => e.includes("ignoring CC 1"));
		assert.strictEqual(logs.length, 1);
	},

	"broken input does not throw out of the MIDI callbacks"() {
		const t = boot(mk2Device());
		t.advance(2000);
		t.midi(0xb0, undefined, undefined);
	},
};

const BLINK_PERIOD = 150;

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (e) {
		failed++;
		console.log(`FAIL ${name}\n     ${e.message}`);
	}
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
