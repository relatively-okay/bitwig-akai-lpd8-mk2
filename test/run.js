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

// --- Mock Bitwig API ----------------------------------------------------------

function value(initial, onSet) {
	const observers = [];
	const v = {
		current: initial,
		markInterested() {},
		get() { return v.current; },
		addValueObserver(f) { observers.push(f); },
		set(x, resolution) {
			v.current = resolution === undefined ? x : x / (resolution - 1);
			if (onSet) onSet(x, resolution);
		},
		emit(x) { v.current = x; observers.forEach((f) => f(x)); },
	};
	return v;
}

function boot(device, options) {
	options = options || {};
	const events = [];
	const log = (e) => events.push(e);
	let now = 0;
	const tasks = [];
	let midiCb, sysexCb;

	function schedule(fn, ms) { tasks.push({ at: now + ms, fn }); }
	function advance(ms) {
		const end = now + ms;
		for (;;) {
			tasks.sort((a, b) => a.at - b.at);
			if (!tasks.length || tasks[0].at > end) break;
			const t = tasks.shift();
			now = t.at;
			t.fn();
		}
		now = end;
	}

	const params = [];
	for (let i = 0; i < 8; i++) {
		params.push({
			ex: value(true), setIndication() {},
			v: value(options.paramValue === undefined ? 0.5 : options.paramValue, (x) => log(`param ${i + 1} = ${x}`)),
			exists() { return this.ex; }, value() { return this.v; },
		});
	}
	const remote = {
		page: value(0), count: value(3), names: value(["Main", "Filter", "Env"]),
		getParameter: (i) => params[i],
		selectedPageIndex() { return this.page; }, pageCount() { return this.count; }, pageNames() { return this.names; },
		selectNextPage() { log("next page"); }, selectPreviousPage() { log("previous page"); },
	};
	const cursorDevice = {
		ex: value(true), nm: value("Polysynth"), pos: value(0), prev: value(false), next: value(true),
		exists() { return this.ex; }, name() { return this.nm; }, position() { return this.pos; },
		hasPrevious() { return this.prev; }, hasNext() { return this.next; },
		selectPrevious() { log("previous device"); }, selectNext() { log("next device"); },
		createCursorRemoteControlsPage: () => remote,
	};
	const cursorTrack = {
		nm: value("Bass"), prev: value(true), next: value(true),
		name() { return this.nm; }, hasPrevious() { return this.prev; }, hasNext() { return this.next; },
		selectPrevious() { log("previous track"); }, selectNext() { log("next track"); },
		stop() { log("stop track"); }, clipLauncherSlotBank: () => clipBank,
		createCursorDevice: () => cursorDevice,
	};
	const userControls = [];
	for (let i = 0; i < 64; i++) {
		userControls.push({ v: value(0.5, (x) => log(`user ${i + 1} = ${x}`)), value() { return this.v; }, setLabel(l) { this.label = l; } });
	}
	const slotObs = [];
	const slots = [];
	for (let k = 0; k < 4; k++) {
		const obs = {};
		slotObs.push(obs);
		const watch = (name) => () => ({ markInterested() {}, addValueObserver: (f) => (obs[name] = f) });
		slots.push({
			hasContent: watch("content"), color: watch("color"), isPlaying: watch("playing"),
			isPlaybackQueued: watch("queued"), isStopQueued: watch("stopping"),
			isRecording: watch("recording"), isRecordingQueued: watch("recordQueued"),
		});
	}
	const clipBank = {
		pos: value(0), back: value(false), fwd: value(true),
		setIndication() {}, getItemAt: (k) => slots[k], launch(k) { log(`launch clip ${k + 1}`); },
		scrollPosition() { return this.pos; }, canScrollBackwards() { return this.back; }, canScrollForwards() { return this.fwd; },
		scrollPageBackwards() { log("previous clips"); }, scrollPageForwards() { log("next clips"); this.pos.current += 4; },
	};
	const pref = value(options.takeover || "Pickup");

	const host = {
		defineController() {}, defineMidiPorts() {}, addDeviceNameBasedDiscoveryPair() {},
		getMidiInPort: () => ({
			createNoteInput(...a) { log(`note input ${a.join(",")}`); return { setShouldConsumeEvents(c) { log(`consume ${c}`); } }; },
			setMidiCallback(f) { midiCb = f; },
			setSysexCallback(f) { sysexCb = f; },
		}),
		getMidiOutPort: () => ({
			sendSysex(s) {
				log(`sysex out ${norm(s)}`);
				const reply = device && device(norm(s));
				if (reply) schedule(() => sysexCb(toBitwigSysex(reply)), 5);
			},
		}),
		getPreferences: () => ({ getEnumSetting: () => pref }),
		createCursorTrack: () => cursorTrack,
		createUserControls: () => ({ getControl: (i) => userControls[i] }),
		createMainTrackBank: () => ({ sceneBank: () => ({ stop() { log("stop all"); } }) }),
		scheduleTask: schedule,
		showPopupNotification(s) { log(`popup ${s}`); },
		println(s) { log(`log ${s}`); },
	};

	const ctx = { host, loadAPI() {}, println: (s) => log(`log ${s}`) };
	ctx.load = () => { throw new Error("script must not use load()"); };
	vm.createContext(ctx);
	vm.runInContext(SCRIPT, ctx, { filename: SCRIPT_PATH });
	ctx.init();

	return {
		events, slotObs, remote, params, advance,
		midi: (s, d1, d2) => midiCb(s, d1, d2),
		exit: () => ctx.exit(),
		take() { return events.splice(0); },
		ready() { advance(2000); return events.splice(0); },
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
const lastColors = (events) => { const c = colorSysex(events); return c.length ? c[c.length - 1] : null; };
const has = (events, re) => events.some((e) => re.test(e));
const actions = (events) => events.filter((e) => !e.startsWith("sysex out") && !e.startsWith("log "));

// Expected pad-colour SysEx for 8 [r, g, b] colours (pads 1-8).
function colors(list) {
	const bytes = [];
	list.forEach((c) => c.forEach((x) => bytes.push(x >> 7, x & 0x7f)));
	return "sysex out F0 47 7F 4C 06 00 30 " + bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ") + " F7";
}
const OFF = [0, 0, 0], NOTE = [0, 0, 40], HIT = [60, 120, 255], STOP = [60, 0, 0], NAV = [40, 40, 40];

// --- Tests ------------------------------------------------------------------

const tests = {

	"script is a single plain-ASCII ES5 file without load()"() {
		assert.ok(!/[^\x09\x0a\x20-\x7e]/.test(SCRIPT), "non-ASCII, control or NUL characters found");
		assert.ok(!/\bload\s*\(/.test(SCRIPT), "load() makes the script depend on other files");
		assert.ok(!/=>|`|\b(let|const|class)\s/.test(SCRIPT), "ES2015+ syntax found");
		assert.deepStrictEqual(fs.readdirSync(ROOT).filter((f) => f.endsWith(".js")), ["AkaiLPD8mk2.control.js"]);
	},

	"handshake: identifies the mk2 and reads all 4 programs read-only"() {
		const t = boot(mk2Device());
		const out = sysexOut(t.events.concat(t.ready())).map((e) => e.slice(10)).filter((s) => !s.startsWith("F0 47 7F 4C 06"));
		assert.deepStrictEqual(out, [
			"F0 7E 7F 06 01 F7",
			"F0 47 7F 4C 03 00 01 01 F7",
			"F0 47 7F 4C 03 00 01 02 F7",
			"F0 47 7F 4C 03 00 01 03 F7",
			"F0 47 7F 4C 03 00 01 04 F7",
		]);
	},

	"handshake: identical factory programs give no warnings and a ready popup"() {
		const ev = boot(mk2Device()).ready();
		assert.ok(!has(ev, /warning/));
		assert.ok(has(ev, /popup LPD8 mk2 ready/));
	},

	"pads still reach instruments: note input on all channels, not consumed"() {
		const ev = boot(mk2Device()).take();
		assert.ok(ev.includes("note input LPD8 mk2 Pads,8?????,9?????,A?????,D?????"));
		assert.ok(ev.includes("consume false"));
	},

	"knobs control the selected device's remote controls"() {
		const t = boot(mk2Device());
		t.ready();
		t.midi(0xb0, 70, 64);
		t.midi(0xb0, 77, 62);
		assert.deepStrictEqual(actions(t.take()), ["param 1 = 64", "param 8 = 62"]);
	},

	"knobs work with the factory mapping before the handshake finishes"() {
		const t = boot(mk2Device());
		t.take();
		t.midi(0xb0, 71, 63);
		assert.deepStrictEqual(actions(t.take()), ["param 2 = 63"]);
	},

	"custom knob CCs are learned from the controller's programs"() {
		const custom = MK2_PROGRAMS.slice();
		const b = custom[0].split(" ");
		for (let k = 0; k < 8; k++) b[140 + 4 * k] = (0x15 + k).toString(16).toUpperCase(); // knobs CC 21-28
		custom[0] = b.join(" ");
		const t = boot(mk2Device(custom));
		t.ready();
		t.midi(0xb0, 21, 64);
		t.midi(0xb0, 70, 64);
		assert.deepStrictEqual(actions(t.take()), ["param 1 = 64", "param 1 = 64"]);
	},

	"pickup: a knob only takes over once it reaches the current value"() {
		const t = boot(mk2Device()); // parameters sit at 0.5 (63.5)
		t.ready();
		t.midi(0xb0, 70, 10);
		t.midi(0xb0, 70, 40);
		assert.deepStrictEqual(actions(t.take()), [], "far from the value: ignored");
		t.midi(0xb0, 70, 90); // crossed 63.5
		t.midi(0xb0, 70, 20); // synced now: follows freely
		assert.deepStrictEqual(actions(t.take()), ["param 1 = 90", "param 1 = 20"]);
	},

	"pickup: switching page makes knobs pick up again"() {
		const t = boot(mk2Device());
		t.ready();
		t.midi(0xb0, 70, 64);
		t.params[0].v.current = 0.9; // the new page's parameter sits elsewhere
		t.remote.page.emit(1);
		t.midi(0xb0, 70, 10);
		assert.deepStrictEqual(actions(t.take()), ["param 1 = 64"]);
	},

	"jump: with the Jump preference knobs set values immediately"() {
		const t = boot(mk2Device(), { takeover: "Jump" });
		t.ready();
		t.midi(0xb0, 70, 3);
		assert.deepStrictEqual(actions(t.take()), ["param 1 = 3"]);
	},

	"PROG CHNG: navigation pads move track, device and page, with popups"() {
		const t = boot(mk2Device());
		t.ready();
		[0, 1, 6, 7, 4, 5].forEach((pc) => t.midi(0xc9, pc, 0));
		t.advance(500);
		const ev = actions(t.take());
		assert.deepStrictEqual(ev.filter((e) => !e.startsWith("popup")),
			["previous track", "next track", "previous device", "next device", "previous page", "next page"]);
		assert.ok(ev.includes("popup Track: Bass"));
		assert.ok(ev.includes("popup Polysynth - Main"));
	},

	"PROG CHNG: knob mode and user banks"() {
		const t = boot(mk2Device());
		t.ready();
		t.midi(0xc9, 2, 0); // knob mode -> user (bank 1)
		t.midi(0xb0, 70, 64);
		t.midi(0xc9, 3, 0); // next user bank -> bank 2
		t.midi(0xb0, 71, 64);
		t.midi(0xc9, 2, 0); // back to device
		t.midi(0xb0, 72, 64);
		t.advance(500);
		const ev = actions(t.take());
		assert.deepStrictEqual(ev.filter((e) => !e.startsWith("popup")), ["user 1 = 64", "user 10 = 64", "param 3 = 64"]);
		assert.ok(ev.includes("popup Knobs: user bank 1"));
		assert.ok(ev.includes("popup Knobs: user bank 2"));
	},

	"CC mode: top row launches the selected track's clips, bottom row stops and scrolls"() {
		const t = boot(mk2Device());
		t.ready();
		[[16, 127], [16, 0], [17, 127], [18, 127], [19, 127], [12, 127], [13, 127], [14, 127], [15, 127]]
			.forEach(([cc, v]) => t.midi(0xb9, cc, v));
		t.advance(500);
		assert.deepStrictEqual(actions(t.take()), ["launch clip 1", "launch clip 2", "launch clip 3", "launch clip 4",
			"stop track", "stop all", "previous clips", "next clips", "popup Clips 5-8", "popup Clips 5-8"]);
	},

	"lights: nothing is sent before the controller is identified"() {
		const t = boot(mk2Device());
		assert.strictEqual(colorSysex(t.events).length, 0);
	},

	"lights: follow the pad mode the controller is in"() {
		const t = boot(mk2Device());
		assert.strictEqual(lastColors(t.ready()), colors([NOTE, NOTE, NOTE, NOTE, NOTE, NOTE, NOTE, NOTE]), "starts in Note mode");

		t.midi(0xb9, 12, 0); // a pad CC: the controller is in CC mode
		assert.strictEqual(lastColors(t.take()), colors([STOP, STOP, OFF, NAV, OFF, OFF, OFF, OFF]),
			"no clips yet; previous-clips is dark at the top");

		t.midi(0xc9, 7, 0); // a pad PC: PROG CHNG mode, navigation layout
		assert.strictEqual(lastColors(t.take()), colors([
			[50, 50, 50], [50, 50, 50], [0, 150, 220], [90, 45, 0],
			OFF, [0, 60, 90], OFF, [70, 0, 100]]), "prev page and prev device are dark at the start");

		t.midi(0x99, 37, 100); // a note: back to Note mode, pad 2 lit while held
		assert.strictEqual(lastColors(t.take()), colors([NOTE, HIT, NOTE, NOTE, NOTE, NOTE, NOTE, NOTE]));
		t.midi(0x89, 37, 0);
		assert.strictEqual(lastColors(t.take()), colors([NOTE, NOTE, NOTE, NOTE, NOTE, NOTE, NOTE, NOTE]));
	},

	"lights: clip pads show the clip's own colour, dim when stopped, bright when playing"() {
		const t = boot(mk2Device());
		t.ready();
		t.midi(0xb9, 12, 0);
		const o = t.slotObs[1]; // clip 2 = pad 6
		o.color(0, 0.5, 1);
		o.content(true);
		const pad6 = () => lastColors(t.take()).split(" ").slice(9 + 5 * 6, 9 + 5 * 6 + 6).join(" ");
		assert.strictEqual(pad6(), "00 00 00 1A 00 33", "dim blue");
		o.playing(true);
		assert.strictEqual(pad6(), "00 00 01 00 01 7F", "bright blue");
		o.recording(true);
		assert.strictEqual(pad6(), "01 7F 00 00 00 00", "red while recording");
	},

	"lights: a queued clip blinks"() {
		const t = boot(mk2Device());
		t.ready();
		t.midi(0xb9, 12, 0);
		t.slotObs[0].content(true);
		t.slotObs[0].queued(true);
		t.take();
		t.advance(300);
		const pad5 = colorSysex(t.take()).map((e) => e.split(" ").slice(9 + 4 * 6, 9 + 4 * 6 + 6).join(" "));
		assert.ok(pad5.includes("01 7F 00 00 00 00") === false && pad5.includes("00 00 00 00 00 00"), "pad 5 should blink: " + pad5);
		assert.ok(pad5.some((c) => c !== "00 00 00 00 00 00"), "pad 5 should blink: " + pad5);
	},

	"lights: exit turns the pads off"() {
		const t = boot(mk2Device());
		t.ready();
		t.exit();
		assert.strictEqual(lastColors(t.take()), colors([OFF, OFF, OFF, OFF, OFF, OFF, OFF, OFF]));
	},

	"original LPD8: says it is not supported and sends nothing else"() {
		const t = boot((out) => (out === "F0 7E 7F 06 01 F7" ? ORIGINAL_IDENTITY : null));
		const ev = t.events.concat(t.ready());
		assert.ok(has(ev, /popup This is an original LPD8/));
		assert.deepStrictEqual(sysexOut(ev), ["sysex out F0 7E 7F 06 01 F7"]);
	},

	"no reply: warns about the output port and keeps the factory mapping"() {
		const t = boot(null);
		assert.ok(has(t.ready(), /popup .*check the controller's MIDI output port/));
		t.midi(0xb0, 70, 64);
		assert.deepStrictEqual(actions(t.take()), ["param 1 = 64"]);
	},

	"unmapped CC is logged once with a hint"() {
		const t = boot(mk2Device());
		t.ready();
		t.midi(0xb0, 1, 5);
		t.midi(0xb0, 1, 6);
		assert.strictEqual(t.take().filter((e) => e.includes("ignoring CC 1")).length, 1);
	},

	"broken input does not throw out of the MIDI callbacks"() {
		const t = boot(mk2Device());
		t.ready();
		t.midi(0xb0, undefined, undefined);
		t.midi(0x90, undefined, undefined);
	},
};

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
