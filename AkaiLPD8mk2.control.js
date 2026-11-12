// Akai LPD8 mk2 control script for Bitwig Studio (control surface API v1).
// https://github.com/relatively-okay/bitwig-akai-lpd8-mk2
//
// This script is deliberately a single, plain-ASCII, ES5 file that loads no
// other files, so copying just this file is a complete installation.
//
// On startup the script asks the controller what it is (MIDI identity
// request) and reads its four programs (read-only), then maps knobs and pads
// from what the controller actually sends. Nothing is ever written to the
// programs stored on the controller.

loadAPI(1);

host.defineController(
	"Akai", "LPD8 mk2",
	"1.0.0", "98c57dd9-d6d9-400c-a9aa-a86db300f2cb"
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
var KNOB_BANKS = 8;

var REPLY_TIMEOUT_MS = 1000;
var BLINK_MS = 150;

var AKAI = 0x47;
var MODEL_MK2 = 0x4c;
var MODEL_LPD8_ORIGINAL = 0x75;

var SYSEX_IDENTITY_REQUEST = "F0 7E 7F 06 01 F7";
var SYSEX_PAD_COLORS = "F0 47 7F 4C 06 00 30";

var OFF            = [ 0, 0, 0 ];
var COLOR_STOP     = [ 60, 0, 0 ];
var COLOR_SCENE    = [ 0, 60, 0 ];
var COLOR_NAV      = [ 40, 40, 40 ];
var COLOR_CLIP     = [ 90, 45, 0 ];
var COLOR_PLAYING  = [ 0, 255, 0 ];
var COLOR_STOPPING = [ 255, 0, 0 ];

// Pad ids (0-7) in CC mode. LPD8 mk2 layout:
//
//   [ 4: launch T1 ] [ 5: launch T2 ] [ 6: launch scene ] [ 7: scene up   ]
//   [ 0: stop T1   ] [ 1: stop T2   ] [ 2: stop all     ] [ 3: scene down ]
var PAD_STOP_T1 = 0, PAD_STOP_T2 = 1, PAD_STOP_ALL = 2, PAD_SCENE_DOWN = 3;
var PAD_LAUNCH_T1 = 4, PAD_LAUNCH_T2 = 5, PAD_LAUNCH_SCENE = 6, PAD_SCENE_UP = 7;


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
	host.scheduleTask( fn, [], ms );
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
//  Mapping: which CC / program change belongs to which knob or pad
// ===========================================================================

function Mapping() {
	this.knobCC = {};
	this.padCC = {};
	this.padPC = {};
	this.warnings = [];
}

Mapping.prototype.add = function( kind, number, index, program ) {
	var table = this[kind];
	var other = kind === "knobCC" ? this.padCC : ( kind === "padCC" ? this.knobCC : null );
	var what = kind === "knobCC" ? "knob" : "pad";
	if ( other !== null && other[number] !== undefined ) {
		this.warnings.push( "program " + program + ": CC " + number + " is used by both a knob and a pad; keeping the first" );
		return;
	}
	if ( table[number] !== undefined && table[number] !== index ) {
		this.warnings.push( "program " + program + ": " + ( kind === "padPC" ? "PC " : "CC " ) + number +
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
	}
};

Mapping.prototype.describe = function() {
	function list( table ) {
		var out = [];
		for ( var n in table ) if ( table.hasOwnProperty( n ) ) out.push( n + ">" + ( table[n] + 1 ) );
		return out.join( " " );
	}
	return "knob CCs [" + list( this.knobCC ) + "] pad CCs [" + list( this.padCC ) +
		"] pad PCs [" + list( this.padPC ) + "]";
};

// LPD8 mk2 factory programs (identical in all four programs).
function factoryMapping() {
	var m = new Mapping();
	for ( var i = 0; i < 8; i++ ) {
		m.knobCC[70 + i] = i;
		m.padCC[12 + i] = i;
		m.padPC[i] = i;
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
	var p = { program: b[7], knobCC: [], padCC: [], padPC: [] };
	for ( var i = 0; i < PADS; i++ ) {
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

	var leds = [];
	var blink_phase = true;
	var last_sysex = null;
	var running = true;

	for ( var i = 0; i < PADS; i++ ) leds[i] = { color: OFF, blink: false };


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

	function onMidi( status, data1, data2 ) {
		var type = status & 0xf0;
		var index;
		if ( type === 0xb0 ) {
			if ( ( index = mapping.knobCC[data1] ) !== undefined ) return handlers.knob( index, data2 );
			if ( ( index = mapping.padCC[data1] ) !== undefined ) return handlers.pad( index, data2 );
		}
		if ( type === 0xc0 ) {
			if ( ( index = mapping.padPC[data1] ) !== undefined ) return handlers.program( index );
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
		later( guarded( "blink", blinkLoop ), BLINK_MS );
	}


	// --- Public -----------------------------------------------------------

	// color: [r, g, b] with 0-255 components; blink: optional bool
	this.setPadColor = function( id, color, blink ) {
		leds[id] = { color: color, blink: !!blink };
		flush();
		return self;
	};

	this.stop = function() {
		for ( var i = 0; i < PADS; i++ ) leds[i] = { color: OFF, blink: false };
		flush();
		running = false;
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

var controller, tracks, userctl, knob_bank = 0;

function init() {

	// Pads in PAD mode play notes (any channel), including pad pressure.
	host.getMidiInPort(0).createNoteInput( "LPD8 mk2 Pads", "8?????", "9?????", "A?????", "D?????" );

	tracks = host.createTrackBank( 2, 0, 1 );
	userctl = host.createUserControlsSection( KNOB_BANKS * KNOBS );

	for ( var i = 0; i < KNOB_BANKS * KNOBS; i++ ) {
		userctl.getControl(i).setLabel( "Bank " + ( Math.floor( i / KNOBS ) + 1 ) + " Knob " + ( i % KNOBS + 1 ) );
	}

	controller = new LPD8mk2( host.getMidiInPort(0), host.getMidiOutPort(0), {

		// Knobs: 8 banks of freely assignable controls.
		knob: function( id, value ) {
			userctl.getControl( knob_bank * KNOBS + id ).set( value, 128 );
		},

		// PROG CHNG mode: pad N selects knob bank N.
		program: function( pad ) {
			knob_bank = pad % KNOB_BANKS;
			host.showPopupNotification( "LPD8 mk2 knob bank " + ( knob_bank + 1 ) );
		},

		// CC mode: clip launcher.
		pad: function( id, value ) {
			if ( value === 0 ) return;
			switch ( id ) {
				case PAD_STOP_T1:      return tracks.getTrack(0).stop();
				case PAD_STOP_T2:      return tracks.getTrack(1).stop();
				case PAD_LAUNCH_T1:    return tracks.getTrack(0).getClipLauncherSlots().launch(0);
				case PAD_LAUNCH_T2:    return tracks.getTrack(1).getClipLauncherSlots().launch(0);
				case PAD_LAUNCH_SCENE: return tracks.launchScene(0);
				case PAD_STOP_ALL:     return tracks.getClipLauncherScenes().stop();
				case PAD_SCENE_UP:     return tracks.scrollScenesUp();
				case PAD_SCENE_DOWN:   return tracks.scrollScenesDown();
			}
		}
	});

	// Static pad colours
	controller.setPadColor( PAD_STOP_T1, COLOR_STOP );
	controller.setPadColor( PAD_STOP_T2, COLOR_STOP );
	controller.setPadColor( PAD_STOP_ALL, COLOR_STOP );
	controller.setPadColor( PAD_LAUNCH_SCENE, COLOR_SCENE );
	controller.setPadColor( PAD_SCENE_UP, COLOR_NAV );
	controller.setPadColor( PAD_SCENE_DOWN, COLOR_NAV );

	// Clip state feedback on the launch pads
	for ( var t = 0; t < 2; t++ ) (function( pad, slots ) {
		var s = { content: false, playing: false, queued: false, stopping: false };

		function update() {
			if ( s.stopping )     controller.setPadColor( pad, COLOR_STOPPING, true );
			else if ( s.queued )  controller.setPadColor( pad, COLOR_PLAYING, true );
			else if ( s.playing ) controller.setPadColor( pad, COLOR_PLAYING );
			else if ( s.content ) controller.setPadColor( pad, COLOR_CLIP );
			else                  controller.setPadColor( pad, OFF );
		}

		slots.setIndication( true );
		slots.addHasContentObserver( function( slot, v ) { s.content = v; update(); } );
		slots.addIsPlayingObserver( function( slot, v ) { s.playing = v; update(); } );
		slots.addIsQueuedObserver( function( slot, v ) { s.queued = v; update(); } );
		try {
			slots.addIsStopQueuedObserver( function( slot, v ) { s.stopping = v; update(); } );
		} catch ( e ) {
			log( "stop-queued feedback unavailable: " + e );
		}
	})( PAD_LAUNCH_T1 + t, tracks.getTrack(t).getClipLauncherSlots() );
}

function exit() {
	tracks.getTrack(0).getClipLauncherSlots().setIndication( false );
	tracks.getTrack(1).getClipLauncherSlots().setIndication( false );
	controller.stop();
}
