"use strict";

// add timestamps in front of log messages
require('console-stamp')(console, {
    label: false,
    labelPrefix: "",
    labelSuffix: "",
    datePrefix: "",
    dateSuffix: "",
});


let RoonApi = require("node-roon-api");
let RoonApiSettings = require("node-roon-api-settings");
let RoonApiStatus = require("node-roon-api-status");
let RoonApiTransport = require("node-roon-api-transport");
let ontime = require('ontime')

var os = require("os");
var hostname = os.hostname();

var core;
var Gpio = require('onoff').Gpio //Include onoff to interact with GPIO
var P_On = new Gpio(12, 'out'); // use GPIO 23 as an output "P_On" to DAC Power
var P_Good = new Gpio(5, 'in', 'both', {debounceTimeout: 10}); // use GPIO 22 as an input "P_Good" as feedback on DAC power. Trigger on both rising and falling edges.
var Trig_Out_1 = new Gpio(13, 'out'); // use GPIO 6 as an output "Trig_Out_1" as an external trigger output
var Trig_Out_2 = new Gpio(16, 'out'); // user GPIO 13 as an output "Trig_Out_2" as an external trigger output
var Trig_In = new Gpio(6, 'in', 'both', {debounceTimeout: 10}); // use GPIO 16 as an input "Trig_In" from an external trigger input. Trigger on both rising and falling edges.

var trg_by = "Status";
var offPause;

let trigger_state = "UNKNOWN"
let last_trigger_write = new Date();

clearTimeout(offPause);

let roon = new RoonApi({
    extension_id:        'com.flyingsparks.roon.dac',
    display_name:        "DAC Power Switch [" + hostname + "]",
    display_version:     "0.2.0",
    publisher:           'Flyingsparks',
    email:               'stefan.raabe@.gmail.com',
    website:             '',
    log_level:           'none',

    core_paired: function(core_) {
        core = core_;
        let transport = core.services.RoonApiTransport;
        let tracker = new_tracker(core, transport);
        transport.subscribe_zones(tracker.zone_event);
    },

    core_unpaired: function(core_) {
        core = undefined;
        console.log("-", "LOST");
    }
});

// Settings in Roon
var mysettings = Object.assign({
    zone:             null,
    turnOnPause:      1,
    turnOffPause:     10
}, roon.load_config("settings") || {});

function makelayout(settings) {
    var l = {
        values:    settings,
	layout:    [],
	has_error: false
    };

    l.layout.push({
	type:    "zone",
	title:   "Zone",
	setting: "zone",
    });

    if (settings.turnOnPause != "none") {
	let v = {
	    type:    "integer",
	    min:     1,
	    max:     20,
	    title:   "Turn On Delay (seconds)",
            subtitle: "This is the delay from pressing play before ROON starts playing to allow the DAC to turn on.",
	    setting: "turnOnPause",
	};
	if (settings.turnOnPause < v.min || settings.turnOnPause > v.max) {
	    v.error = "Turn On Delay must be between 1 and 20 seconds.";
	    l.has_error = true; 
	}
        l.layout.push(v);
    }

    if (settings.turnOffPause != "none") {
        let v = {
            type:    "integer",
            min:     1,
            max:     3600,
            title:   "Turn Off Delay (seconds)",
            subtitle: "This is the delay from pressing stop before ROON turns off the DAC.",
            setting: "turnOffPause",
        };
        if (settings.turnOffPause < v.min || settings.turnOffPause > v.max) {
            v.error = "Turn Off Delay must be between 1 and 3600 seconds.";
            l.has_error = true;
        }
        l.layout.push(v);
    }

    return l;
}

var svc_settings = new RoonApiSettings(roon, {
    get_settings: function(cb) {
        cb(makelayout(mysettings));
    },
    save_settings: function(req, isdryrun, settings) {
	let l = makelayout(settings.values);
        req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l });

        if (!isdryrun && !l.has_error) {
            mysettings = l.values;
            svc_settings.update_settings(l);
            roon.save_config("settings", mysettings);
        }
    }
});

// get current state at startup, ensure we have the state before we start
// processing events from Roon.
//amp_trigger_msg('STAT', function(data) {
//    trigger_callback(data);
//    roon.start_discovery();
//})
//trigger_callback(data);

roon.start_discovery();

let svc_status = new RoonApiStatus(roon);

roon.init_services({
    required_services: [ RoonApiTransport ],
    provided_services: [ svc_settings, svc_status ],
});

svc_status.set_status("All is good", false);
read_dac_gpio();

// Track a Roon zone
function new_tracker(core, transport) {
    let t = {
        zone: null,
        zone_id: "",
        last_state : "",
    }

    t.on_state_changed = function() {
        console.log("zone state now " + t.last_state)
        if (!((t.last_state != "playing") && (t.last_state != "loading"))) {
            if (trigger_state == false) {
                clearTimeout( offPause );
                transport.control(t.zone, "pause", (x) => setTimeout(() => transport.control(t.zone, "play"), mysettings.turnOnPause*1000))
            }
            trg_by = "ROON"
            set_trigger(true)
        }
        if (!(t.last_state != "stopped")) {
            clearTimeout(offPause)
            trg_by = "ROON"
            offPause = setTimeout(() => {set_trigger(false); }, mysettings.turnOffPause*1000);
        }
    }

    t.zone_event = function(cmd, data) {
        if (cmd == "Subscribed") {
            data.zones.forEach( z => { 
                if (z.display_name == mysettings.zone.name) {
                    t.zone = z;
                    t.zone_id = z.zone_id;
                    t.last_state = z.state;
                }
            })
            console.log("zones", t.zone.display_name, t.zone_id, t.last_state);
            t.on_state_changed();

        } else if (cmd == "Changed") {
            if ("zones_changed" in data) {
                data.zones_changed.forEach( z => {
                    if ((z.zone_id == t.zone_id) && (z.state != t.last_state)) {
                        t.last_state = z.state;
                        t.on_state_changed();
                    }
                })
            } else if ("zones_seek_changed" in data) {
                // skip
            } else {
                console.log(cmd, data);
            }
        }
    }
    return t
}

// time is in UTC
//ontime({
//    cycle: '07:10:00'
//}, function (ot) {
//    console.log('Scheduled: turning amp off')
//    set_trigger(false)
//    ot.done()
//    return
//})

// update the trigger state to the new state (true/false for on/off)
function set_trigger(newStateBool) {
    let newState = newStateBool ? "ON" : "OFF";
    if (newState == trigger_state) {
        // If we think we're not going to make a change, and we've talked to the trigger
        // recently, skip doing this
        if ((new Date().getTime() - last_trigger_write.getTime()) < 10000) {
            console.log("skipping no-op trigger change of: " + newState + ", current state is: " + trigger_state);
            return;
        }
    }
    dac_trigger_gpio(newStateBool ? 1: 0, read_dac_gpio);
}

const trigger_on = Buffer.from('ON  ')

function trigger_callback(data) {
    let new_state = data.compare(trigger_on, 0,4,0,4) == 0 ? "ON" : "OFF"
    console.log("Trigger state was " + trigger_state + " now " + new_state);
    trigger_state = new_state;
    svc_status.set_status("DAC Power: " + new_state, false);
}

// dac_trigger_gpio is a helper that sets teh gpio controlling the dac trigger signals
// and pass the response to the callback.
function dac_trigger_gpio(trg, callback) {
    console.log("setting P_On:" + trg)
    last_trigger_write = new Date();

    P_On.writeSync(trg); // set P_On GPIO to pon.
    Trig_Out_1.writeSync(trg);
    Trig_Out_2.writeSync(trg);
//    callback = read_dac_gpio();
}

function read_dac_gpio() {
    let pon = P_On.readSync();
    let pgood = P_Good.readSync();
    let new_state = pgood ? "ON" : "OFF"
    let trigIn = Trig_In.readSync();
    let trig1 = Trig_Out_1.readSync();
    let trig2 = Trig_Out_2.readSync();

//    let trg_by = pon == pgood ? "ROON" : "DAC"
    trigger_state = new_state;
    console.log("P_Good: " + pgood + ",  P_On: " + pon + ",  Trig_In: " + trigIn + ",  Trig Out 1: " + trig1 + ",  Trig Out 2: " + trig2);
    svc_status.set_status("DAC Power: " + new_state + " by " + trg_by, false);
    return [pon, pgood]
}

// Watch for interrupts on the P_Good line to track Power On/Off events by user or by LiFePO4 turning off based on timers, battery voltage etc.
P_Good.watch(function (err, value) { //Watch hardware interrupts on P_GOod GPIO, specify callback function
  if (err) { //if error
    console.error('There was an error', err); //output error message to console
  return;
  }
  if (value != P_On.readSync()) trg_by="DAC";
  read_dac_gpio();
  if (value == 0) {
      core.services.RoonApiTransport.control(mysettings.zone, 'pause');
      dac_trigger_gpio(0);
      setTimeout(() => clearTimeout(offPause), 1000);
  }
});

// Watch for interrupts on the Trig_In pin to turn on based on the External Trigger
Trig_In.watch(function(err, value) {
    if (err){ //if error
        console.error('There was an error', err);  //output error message to console
    return;
    }
    trg_by = "EXT TRIGGER";
    console.log("External trigger: " + value);
    dac_trigger_gpio(value);
});



