// Akai LPD8 mk2 control script for Bitwig Studio.
// https://github.com/relatively-okay/bitwig-akai-lpd8-mk2
//
// This script is deliberately a single, plain-ASCII, ES5 file that loads no
// other files, so copying just this file is a complete installation.
//
// On startup the script asks the controller what it is (MIDI identity
// request) and reads its four programs (read-only), then maps knobs and pads
// from what the controller actually sends. Nothing is ever written to the
// programs stored on the controller.
//
//   Knobs           : the selected device's Remote Controls (or user controls)
//   Note mode       : pads play notes
//   CC mode         : clip launcher for the selected track
//   PROG CHNG mode  : navigation (tracks, devices, pages, knob mode)

loadAPI(10);

host.defineController(
	"Akai", "LPD8 mk2",
	"2.0.0", "98c57dd9-d6d9-400c-a9aa-a86db300f2cb"
);
host.defineMidiPorts( 1, 1 );
host.addDeviceNameBasedDiscoveryPair( ["LPD8 mk2 MIDI 1"], ["LPD8 mk2 MIDI 1"] );
host.addDeviceNameBasedDiscoveryPair( ["LPD8 mk2"], ["LPD8 mk2"] );


// ===========================================================================
//  Constants
// ===========================================================================

var PADS = 8;
var KNOBS = 8;
var PROGRAMS = 4;
var USER_BANKS = 8;

var REPLY_TIMEOUT_MS = 1000;
var BLINK_MS = 150;
var ANNOUNCE_DELAY_MS = 150;
var PICKUP_WINDOW = 2;

var AKAI = 0x47;
var MODEL_MK2 = 0x4c;
var MODEL_LPD8_ORIGINAL = 0x75;

var SYSEX_IDENTITY_REQUEST = "F0 7E 7F 06 01 F7";
var SYSEX_PAD_COLORS = "F0 47 7F 4C 06 00 30";

// Pad modes, as selected with the buttons on the LPD8 mk2. The controller
// doesn't report its mode, so the script infers it from what the pads send.
var MODE_NOTE = "note", MODE_CC = "cc", MODE_PROG = "prog";
var MODES = [ MODE_NOTE, MODE_CC, MODE_PROG ];

var KNOBS_DEVICE = "device", KNOBS_USER = "user";

var CLIP_SLOTS = 4;
var CLIP_DIM = 0.2;            // brightness of a clip that isn't playing

var OFF            = [ 0, 0, 0 ];
var COLOR_NOTE     = [ 0, 0, 40 ];
var COLOR_NOTE_HIT = [ 60, 120, 255 ];
var COLOR_STOP     = [ 60, 0, 0 ];
var COLOR_NAV      = [ 40, 40, 40 ];
var COLOR_CLIP     = [ 255, 128, 0 ];   // for clips without a colour
var COLOR_RED      = [ 255, 0, 0 ];
var COLOR_TRACK    = [ 50, 50, 50 ];
var COLOR_DEVICE   = [ 70, 0, 100 ];
var COLOR_PAGE     = [ 0, 60, 90 ];
var COLOR_MODE_DEVICE = [ 0, 150, 220 ];
var COLOR_MODE_USER   = [ 220, 110, 0 ];
var COLOR_USER_BANK   = [ 90, 45, 0 ];

// Pad ids 0-7. LPD8 mk2 layout: pads 5-8 on top, pads 1-4 below.
//
// CC mode (clip launcher for the selected track):
//   [ 4: clip 1     ] [ 5: clip 2   ] [ 6: clip 3       ] [ 7: clip 4       ]
//   [ 0: stop track ] [ 1: stop all ] [ 2: prev 4 clips ] [ 3: next 4 clips ]
var PAD_STOP_TRACK = 0, PAD_STOP_ALL = 1, PAD_PREV_CLIPS = 2, PAD_NEXT_CLIPS = 3, PAD_FIRST_CLIP = 4;

// PROG CHNG mode (navigation):
//   [ 4: prev page  ] [ 5: next page  ] [ 6: prev device ] [ 7: next device ]
//   [ 0: prev track ] [ 1: next track ] [ 2: knob mode   ] [ 3: user bank   ]
var NAV_PREV_TRACK = 0, NAV_NEXT_TRACK = 1, NAV_KNOB_MODE = 2, NAV_USER_BANK = 3;
var NAV_PREV_PAGE = 4, NAV_NEXT_PAGE = 5, NAV_PREV_DEVICE = 6, NAV_NEXT_DEVICE = 7;


// ===========================================================================
//  Helpers
// ===========================================================================

function hex2( value ) {
	var s = ( value & 0xff ).toString( 16 ).toUpperCase();
	return s.length < 2 ? "0" + s : s;
}

// Bitwig hands SysEx over as a hex string; accept any spacing or case.
function hexToBytes( data ) {
	var hex = String( data ).replace( /[^0-9a-fA-F]/g, "" );
	var bytes = [];
	for ( var i = 0; i + 1 < hex.length; i += 2 ) {
		bytes.push( parseInt( hex.substr( i, 2 ), 16 ) );
	}
	return bytes;
}

function startsWith( bytes, prefix ) {
	if ( bytes.length < prefix.length ) return false;
	for ( var i = 0; i < prefix.length; i++ ) {
		if ( prefix[i] !== null && bytes[i] !== prefix[i] ) return false;
	}
	return true;
}

function later( fn, ms ) {
	host.scheduleTask( guarded( "scheduled task", fn ), ms );
}

function log( text ) {
	println( "LPD8 mk2: " + text );
}

// Runs fn, logging instead of throwing, so one bad message cannot take the
// script down.
function guarded( name, fn ) {
	return function() {
		try {
			return fn.apply( this, arguments );
		} catch ( e ) {
			log( "error in " + name + ": " + e );
		}
	};
}


// ===========================================================================
//  Mapping: which note / CC / program change belongs to which knob or pad
// ===========================================================================

function Mapping() {
	this.knobCC = {};
	this.padCC = {};
	this.padPC = {};
	this.padNote = {};
	this.warnings = [];
}

Mapping.prototype.add = function( kind, number, index, program ) {
	var table = this[kind];
	var other = kind === "knobCC" ? this.padCC : ( kind === "padCC" ? this.knobCC : null );
	var what = kind === "knobCC" ? "knob" : "pad";
	var label = { knobCC: "CC ", padCC: "CC ", padPC: "PC ", padNote: "note " }[kind];
	if ( other !== null && other[number] !== undefined ) {
		this.warnings.push( "program " + program + ": CC " + number + " is used by both a knob and a pad; keeping the first" );
		return;
	}
	if ( table[number] !== undefined && table[number] !== index ) {
		this.warnings.push( "program " + program + ": " + label + number +
			" is " + what + " " + ( index + 1 ) + " here but " + what + " " + ( table[number] + 1 ) +
			" in an earlier program; keeping the first" );
		return;
	}
	table[number] = index;
};

Mapping.prototype.addProgram = function( p ) {
	for ( var i = 0; i < KNOBS; i++ ) this.add( "knobCC", p.knobCC[i], i, p.program );
	for ( var j = 0; j < PADS; j++ ) {
		this.add( "padCC", p.padCC[j], j, p.program );
		this.add( "padPC", p.padPC[j], j, p.program );
		this.add( "padNote", p.padNote[j], j, p.program );
	}
};

Mapping.prototype.describe = function() {
	function list( table ) {
		var out = [];
		for ( var n in table ) if ( table.hasOwnProperty( n ) ) out.push( n + ">" + ( table[n] + 1 ) );
		return out.join( " " );
	}
	return "knob CCs [" + list( this.knobCC ) + "] pad CCs [" + list( this.padCC ) +
		"] pad PCs [" + list( this.padPC ) + "] pad notes [" + list( this.padNote ) + "]";
};

// LPD8 mk2 factory programs (identical in all four programs).
function factoryMapping() {
	var m = new Mapping();
	for ( var i = 0; i < 8; i++ ) {
		m.knobCC[70 + i] = i;
		m.padCC[12 + i] = i;
		m.padPC[i] = i;
		m.padNote[36 + i] = i;
	}
	return m;
}


// ===========================================================================
//  Program dump parser (read-only)
// ===========================================================================

function programRequest( n ) {
	return "F0 47 7F 4C 03 00 01 " + hex2( n ) + " F7";
}

// Reply to programRequest(n), 173 bytes:
//   [7] program, [8..11] globals,
//   [12 + 16*i] pad i: note, CC, PC, channel, 12 colour bytes,
//   [140 + 4*i] knob i: CC, channel, min, max
function parseProgram( b ) {
	if ( b.length !== 173 || !startsWith( b, [ 0xf0, AKAI, null, MODEL_MK2, 0x03 ] ) || b[172] !== 0xf7 ) {
		return null;
	}
	var p = { program: b[7], knobCC: [], padCC: [], padPC: [], padNote: [] };
	for ( var i = 0; i < PADS; i++ ) {
		p.padNote.push( b[12 + 16 * i] );
		p.padCC.push( b[12 + 16 * i + 1] );
		p.padPC.push( b[12 + 16 * i + 2] );
	}
	for ( var k = 0; k < KNOBS; k++ ) p.knobCC.push( b[140 + 4 * k] );
	return p;
}


// ===========================================================================
//  Controller: talks MIDI to the LPD8 mk2
// ===========================================================================

function LPD8mk2( midi_in, midi_out, handlers ) {

	var self = this;

	var identified = false;
	var mapping = factoryMapping();
	var programs = [];             // parsed program dumps
	var pending = null;            // { kind, token } of the outstanding request
	var token = 0;
	var reported = {};             // unmapped messages already logged
	var mode = MODE_NOTE;

	// One LED layer per pad mode; the current mode's layer is shown.
	var layers = {};
	var blink_phase = true;
	var last_sysex = null;
	var running = true;

	for ( var m = 0; m < MODES.length; m++ ) {
		layers[MODES[m]] = [];
		for ( var i = 0; i < PADS; i++ ) layers[MODES[m]][i] = { color: OFF, blink: false };
	}


	// --- Startup handshake ------------------------------------------------

	function request( kind, sysex ) {
		var my_token = ++token;
		pending = { kind: kind, token: my_token };
		midi_out.sendSysex( sysex );
		later( function() {
			if ( running && pending !== null && pending.token === my_token ) onTimeout( kind );
		}, REPLY_TIMEOUT_MS );
	}

	function onTimeout( kind ) {
		pending = null;
		if ( kind === "identity" ) {
			log( "no reply to the identity request. Check that the controller's MIDI OUTPUT port " +
				"is set to the LPD8 mk2 in Settings > Controllers. Using the factory mapping." );
			host.showPopupNotification( "LPD8 mk2: no reply - check the controller's MIDI output port" );
			return finish();
		}
		log( "no reply when reading " + kind + "; using what was read so far" );
		finish();
	}

	function onIdentity( b ) {
		// F0 7E <device> 06 02 <manufacturer> <family lo> <family hi> ...
		pending = null;
		if ( b[5] === AKAI && b[6] === MODEL_LPD8_ORIGINAL ) {
			log( "this is a first-generation LPD8; this script only supports the LPD8 mk2." );
			host.showPopupNotification( "This is an original LPD8 - this script is for the LPD8 mk2 only" );
			return;
		}
		if ( b[5] !== AKAI || b[6] !== MODEL_MK2 ) {
			log( "unknown device replied to the identity request (manufacturer " + hex2( b[5] ) +
				", family " + hex2( b[6] ) + "). Using the factory mapping." );
			return finish();
		}
		identified = true;
		log( "found LPD8 mk2; reading its programs (read-only)" );
		flush();
		request( "program 1", programRequest( 1 ) );
	}

	function onProgram( b ) {
		var p = parseProgram( b );
		if ( p === null ) {
			log( "could not parse program dump (" + b.length + " bytes); ignoring it" );
			return;
		}
		programs.push( p );
		if ( p.program < PROGRAMS ) return request( "program " + ( p.program + 1 ), programRequest( p.program + 1 ) );
		pending = null;
		finish();
	}

	function finish() {
		if ( programs.length > 0 ) {
			var m = new Mapping();
			for ( var i = 0; i < programs.length; i++ ) m.addProgram( programs[i] );
			for ( var j = 0; j < m.warnings.length; j++ ) log( "warning: " + m.warnings[j] );
			mapping = m;
		}
		log( "mapping: " + mapping.describe() );
		host.showPopupNotification( "LPD8 mk2 ready" );
	}


	// --- MIDI input -------------------------------------------------------

	function setMode( new_mode ) {
		if ( new_mode === mode ) return;
		mode = new_mode;
		flush();
	}

	function onMidi( status, data1, data2 ) {
		var type = status & 0xf0;
		var index;
		if ( type === 0xb0 ) {
			if ( ( index = mapping.knobCC[data1] ) !== undefined ) return handlers.knob( index, data2 );
			if ( ( index = mapping.padCC[data1] ) !== undefined ) {
				setMode( MODE_CC );
				return handlers.padCC( index, data2 );
			}
		}
		if ( type === 0xc0 ) {
			if ( ( index = mapping.padPC[data1] ) !== undefined ) {
				setMode( MODE_PROG );
				return handlers.padPC( index );
			}
		}
		if ( type === 0x90 || type === 0x80 ) {
			// The notes themselves reach instruments through the note input;
			// this only drives the pad lights.
			if ( ( index = mapping.padNote[data1] ) !== undefined ) {
				setMode( MODE_NOTE );
				return handlers.padNote( index, type === 0x90 ? data2 : 0 );
			}
			return;
		}
		reportUnmapped( status, data1 );
	}

	function reportUnmapped( status, data1 ) {
		var type = status & 0xf0;
		var name = type === 0xb0 ? "CC " : ( type === 0xc0 ? "program change " : null );
		if ( name === null ) return;
		var key = type + ":" + data1;
		if ( reported[key] ) return;
		reported[key] = true;
		log( "ignoring " + name + data1 + " on channel " + ( ( status & 0x0f ) + 1 ) +
			": not a knob or pad in the controller's programs. If you changed the programs, " +
			"turn the controller off and on in Bitwig to re-read them." );
	}

	function onSysex( data ) {
		var b = hexToBytes( data );
		if ( startsWith( b, [ 0xf0, 0x7e, null, 0x06, 0x02 ] ) ) {
			if ( pending !== null && pending.kind === "identity" ) onIdentity( b );
			return;
		}
		if ( identified && pending !== null && pending.kind.indexOf( "program" ) === 0 &&
			startsWith( b, [ 0xf0, AKAI ] ) ) {
			return onProgram( b );
		}
	}


	// --- Pad LEDs ---------------------------------------------------------

	function flush() {
		if ( !identified ) return;
		var leds = layers[mode];
		var bytes = [];
		for ( var i = 0; i < PADS; i++ ) {
			var c = ( leds[i].blink && !blink_phase ) ? OFF : leds[i].color;
			for ( var j = 0; j < 3; j++ ) {
				bytes.push( hex2( ( c[j] >> 7 ) & 0x01 ), hex2( c[j] & 0x7f ) );
			}
		}
		var sysex = SYSEX_PAD_COLORS + " " + bytes.join( " " ) + " F7";
		if ( sysex === last_sysex ) return;
		last_sysex = sysex;
		midi_out.sendSysex( sysex );
	}

	function blinkLoop() {
		if ( !running ) return;
		blink_phase = !blink_phase;
		flush();
		later( blinkLoop, BLINK_MS );
	}


	// --- Public -----------------------------------------------------------

	// layer: MODE_*; color: [r, g, b] with 0-255 components; blink: optional bool
	this.setPadColor = function( layer, id, color, blink ) {
		layers[layer][id] = { color: color, blink: !!blink };
		if ( layer === mode ) flush();
		return self;
	};

	this.stop = function() {
		running = false;
		for ( var i = 0; i < PADS; i++ ) layers[mode][i] = { color: OFF, blink: false };
		flush();
		return self;
	};

	midi_in.setMidiCallback( guarded( "MIDI input", onMidi ) );
	midi_in.setSysexCallback( guarded( "SysEx input", onSysex ) );
	blinkLoop();
	request( "identity", SYSEX_IDENTITY_REQUEST );
}


// ===========================================================================
//  Bitwig wiring
// ===========================================================================

var controller, cursorTrack, cursorDevice, remote, userControls, clipSlots, allScenes, takeover;
var knob_mode = KNOBS_DEVICE;
var user_bank = 0;

// Soft takeover state per physical knob.
var knob_last = [];     // last raw value the knob sent
var knob_synced = [];   // knob has caught up with its current target

function resetTakeover() {
	for ( var i = 0; i < KNOBS; i++ ) knob_synced[i] = false;
}

function knobTarget( i ) {
	return knob_mode === KNOBS_DEVICE ? remote.getParameter( i ) : userControls.getControl( user_bank * KNOBS + i );
}

function onKnob( i, value ) {
	var p = knobTarget( i );
	var last = knob_last[i];
	knob_last[i] = value;
	if ( knob_mode === KNOBS_DEVICE && !p.exists().get() ) return;

	if ( !knob_synced[i] && takeover.get() === "Pickup" ) {
		// Only take over once the knob reaches the parameter's current value,
		// so switching pages, devices or banks never makes values jump.
		var target = p.value().get() * 127;
		var reached = Math.abs( value - target ) <= PICKUP_WINDOW ||
			( last !== undefined && ( last - target ) * ( value - target ) <= 0 );
		if ( !reached ) return;
	}
	knob_synced[i] = true;
	p.value().set( value, 128 );
}

// Shows where a navigation pad took you. Track and device names arrive from
// Bitwig a moment after the move, hence the delay.
function announce( what ) {
	if ( what === "knobs" && knob_mode === KNOBS_USER ) {
		host.showPopupNotification( "Knobs: user bank " + ( user_bank + 1 ) );
		return;
	}
	later( function() {
		if ( what === "clips" ) {
			var first = clipSlots.scrollPosition().get() + 1;
			host.showPopupNotification( "Clips " + first + "-" + ( first + CLIP_SLOTS - 1 ) );
			return;
		}
		if ( what === "track" ) {
			host.showPopupNotification( "Track: " + ( cursorTrack.name().get() || "-" ) );
			return;
		}
		if ( !cursorDevice.exists().get() ) {
			host.showPopupNotification( "Knobs: no device selected" );
			return;
		}
		var pages = remote.pageNames().get();
		var page = pages[ remote.selectedPageIndex().get() ];
		host.showPopupNotification( cursorDevice.name().get() + ( page ? " - " + page : "" ) );
	}, ANNOUNCE_DELAY_MS );
}

function init() {

	// Pads in Note mode play notes (any channel), including pad pressure.
	// The notes are also passed to the script so the pads can light up.
	var noteInput = host.getMidiInPort(0).createNoteInput( "LPD8 mk2 Pads", "8?????", "9?????", "A?????", "D?????" );
	noteInput.setShouldConsumeEvents( false );

	takeover = host.getPreferences().getEnumSetting( "Knob takeover", "Knobs", [ "Pickup", "Jump" ], "Pickup" );
	takeover.markInterested();

	// Knobs: the selected device's Remote Controls, or user controls.
	cursorTrack = host.createCursorTrack( "LPD8MK2_CURSOR", "LPD8 mk2", 0, CLIP_SLOTS, true );
	cursorDevice = cursorTrack.createCursorDevice();
	remote = cursorDevice.createCursorRemoteControlsPage( KNOBS );
	userControls = host.createUserControls( USER_BANKS * KNOBS );

	cursorTrack.name().markInterested();
	cursorDevice.exists().markInterested();
	cursorDevice.name().markInterested();
	remote.pageNames().markInterested();

	for ( var i = 0; i < KNOBS; i++ ) {
		var p = remote.getParameter( i );
		p.exists().markInterested();
		p.value().markInterested();
		p.setIndication( true );
	}
	for ( var u = 0; u < USER_BANKS * KNOBS; u++ ) {
		var c = userControls.getControl( u );
		c.value().markInterested();
		c.setLabel( "User bank " + ( Math.floor( u / KNOBS ) + 1 ) + " knob " + ( u % KNOBS + 1 ) );
	}

	// A new target for the knobs: they must pick up again.
	remote.selectedPageIndex().addValueObserver( function() { resetTakeover(); updateNavLeds(); } );
	remote.pageCount().addValueObserver( function() { updateNavLeds(); } );
	cursorDevice.name().addValueObserver( function() { resetTakeover(); } );
	cursorDevice.position().addValueObserver( function() { resetTakeover(); } );
	cursorTrack.hasPrevious().addValueObserver( function() { updateNavLeds(); } );
	cursorTrack.hasNext().addValueObserver( function() { updateNavLeds(); } );
	cursorDevice.hasPrevious().addValueObserver( function() { updateNavLeds(); } );
	cursorDevice.hasNext().addValueObserver( function() { updateNavLeds(); } );

	// Clip launcher: four clip slots of the selected track.
	clipSlots = cursorTrack.clipLauncherSlotBank();
	clipSlots.setIndication( true );
	clipSlots.scrollPosition().markInterested();
	clipSlots.canScrollBackwards().addValueObserver( function() { updateClipNavLeds(); } );
	clipSlots.canScrollForwards().addValueObserver( function() { updateClipNavLeds(); } );
	allScenes = host.createMainTrackBank( 1, 0, 1 ).sceneBank();

	controller = new LPD8mk2( host.getMidiInPort(0), host.getMidiOutPort(0), {

		knob: onKnob,

		// Note mode: light the pad while it is held.
		padNote: function( id, velocity ) {
			controller.setPadColor( MODE_NOTE, id, velocity > 0 ? COLOR_NOTE_HIT : COLOR_NOTE );
		},

		// CC mode: clip launcher.
		padCC: function( id, value ) {
			if ( value === 0 ) return;
			if ( id >= PAD_FIRST_CLIP ) return clipSlots.launch( id - PAD_FIRST_CLIP );
			switch ( id ) {
				case PAD_STOP_TRACK: return cursorTrack.stop();
				case PAD_STOP_ALL:   return allScenes.stop();
				case PAD_PREV_CLIPS: clipSlots.scrollPageBackwards(); return announce( "clips" );
				case PAD_NEXT_CLIPS: clipSlots.scrollPageForwards(); return announce( "clips" );
			}
		},

		// PROG CHNG mode: navigation.
		padPC: function( id ) {
			switch ( id ) {
				case NAV_PREV_TRACK:  cursorTrack.selectPrevious(); return announce( "track" );
				case NAV_NEXT_TRACK:  cursorTrack.selectNext(); return announce( "track" );
				case NAV_PREV_DEVICE: cursorDevice.selectPrevious(); return announce( "device" );
				case NAV_NEXT_DEVICE: cursorDevice.selectNext(); return announce( "device" );
				case NAV_PREV_PAGE:   remote.selectPreviousPage( false ); return announce( "device" );
				case NAV_NEXT_PAGE:   remote.selectNextPage( false ); return announce( "device" );
				case NAV_KNOB_MODE:
					knob_mode = knob_mode === KNOBS_DEVICE ? KNOBS_USER : KNOBS_DEVICE;
					break;
				case NAV_USER_BANK:
					if ( knob_mode === KNOBS_USER ) user_bank = ( user_bank + 1 ) % USER_BANKS;
					knob_mode = KNOBS_USER;
					break;
			}
			resetTakeover();
			updateNavLeds();
			announce( "knobs" );
		}
	});

	// Note mode lights
	for ( var n = 0; n < PADS; n++ ) controller.setPadColor( MODE_NOTE, n, COLOR_NOTE );

	// CC mode lights: each clip pad shows its clip in the clip's own colour,
	// dim when stopped, bright when playing, blinking when about to start.
	// Red: recording (blinking: about to stop or start recording).
	controller.setPadColor( MODE_CC, PAD_STOP_TRACK, COLOR_STOP );
	controller.setPadColor( MODE_CC, PAD_STOP_ALL, COLOR_STOP );

	for ( var k = 0; k < CLIP_SLOTS; k++ ) (function( pad, slot ) {
		var s = { content: false, color: COLOR_CLIP, playing: false, queued: false, stopping: false,
			recording: false, recordQueued: false };

		function scaled( f ) {
			return [ Math.round( s.color[0] * f ), Math.round( s.color[1] * f ), Math.round( s.color[2] * f ) ];
		}

		function update() {
			if ( s.recording )                       controller.setPadColor( MODE_CC, pad, COLOR_RED );
			else if ( s.recordQueued || s.stopping ) controller.setPadColor( MODE_CC, pad, COLOR_RED, true );
			else if ( s.queued )                     controller.setPadColor( MODE_CC, pad, scaled( 1 ), true );
			else if ( s.playing )                    controller.setPadColor( MODE_CC, pad, scaled( 1 ) );
			else if ( s.content )                    controller.setPadColor( MODE_CC, pad, scaled( CLIP_DIM ) );
			else                                     controller.setPadColor( MODE_CC, pad, OFF );
		}

		slot.hasContent().addValueObserver( function( v ) { s.content = v; update(); } );
		slot.color().addValueObserver( function( r, g, b ) {
			// Clips without a colour come through as black.
			s.color = ( r + g + b < 0.05 ) ? COLOR_CLIP : [ r * 255, g * 255, b * 255 ];
			update();
		} );
		slot.isPlaying().addValueObserver( function( v ) { s.playing = v; update(); } );
		slot.isPlaybackQueued().addValueObserver( function( v ) { s.queued = v; update(); } );
		slot.isStopQueued().addValueObserver( function( v ) { s.stopping = v; update(); } );
		slot.isRecording().addValueObserver( function( v ) { s.recording = v; update(); } );
		slot.isRecordingQueued().addValueObserver( function( v ) { s.recordQueued = v; update(); } );
	})( PAD_FIRST_CLIP + k, clipSlots.getItemAt( k ) );

	resetTakeover();
	updateNavLeds();
	updateClipNavLeds();
}

// CC mode: the clip scroll pads go dark where there are no more clips.
function updateClipNavLeds() {
	if ( !controller ) return;
	controller.setPadColor( MODE_CC, PAD_PREV_CLIPS, clipSlots.canScrollBackwards().get() ? COLOR_NAV : OFF );
	controller.setPadColor( MODE_CC, PAD_NEXT_CLIPS, clipSlots.canScrollForwards().get() ? COLOR_NAV : OFF );
}

// PROG CHNG mode lights; arrows go dark where there is nowhere to go.
function updateNavLeds() {
	if ( !controller ) return;
	var page = remote.selectedPageIndex().get(), pages = remote.pageCount().get();
	function nav( id, available, color ) {
		controller.setPadColor( MODE_PROG, id, available ? color : OFF );
	}
	nav( NAV_PREV_TRACK, cursorTrack.hasPrevious().get(), COLOR_TRACK );
	nav( NAV_NEXT_TRACK, cursorTrack.hasNext().get(), COLOR_TRACK );
	nav( NAV_PREV_DEVICE, cursorDevice.hasPrevious().get(), COLOR_DEVICE );
	nav( NAV_NEXT_DEVICE, cursorDevice.hasNext().get(), COLOR_DEVICE );
	nav( NAV_PREV_PAGE, page > 0, COLOR_PAGE );
	nav( NAV_NEXT_PAGE, page < pages - 1, COLOR_PAGE );
	controller.setPadColor( MODE_PROG, NAV_KNOB_MODE, knob_mode === KNOBS_DEVICE ? COLOR_MODE_DEVICE : COLOR_MODE_USER );
	controller.setPadColor( MODE_PROG, NAV_USER_BANK, knob_mode === KNOBS_USER ? COLOR_MODE_USER : COLOR_USER_BANK );
}

function exit() {
	clipSlots.setIndication( false );
	for ( var i = 0; i < KNOBS; i++ ) remote.getParameter( i ).setIndication( false );
	controller.stop();
}
