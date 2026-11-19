// Vehicle roster shared by the server simulation and the spectator client.
// Both sides derive authoritative truth from the same curve and speed law, so
// the client can grade what it draws without any oracle channel.
export const VEHICLE_SETUP = [
  {
    id: "v1",
    name: "NOVA",
    color: "#ff5d3b",
    startDistance: 0,
    lateral: -3.2,
    hoverPhase: 0.0,
    speedShift: 0.0,
    drivable: false,
  },
  {
    id: "v2",
    name: "KESTREL",
    color: "#33d6ff",
    startDistance: 22,
    lateral: 3.2,
    hoverPhase: 1.35,
    speedShift: 0.17,
    drivable: false,
  },
  {
    id: "v3",
    name: "SABLE",
    color: "#ffd447",
    startDistance: 44,
    lateral: -1.5,
    hoverPhase: 2.9,
    speedShift: 0.39,
    drivable: false,
  },
  {
    id: "v4",
    name: "JUNO",
    color: "#a583ff",
    startDistance: 66,
    lateral: 1.5,
    hoverPhase: 4.3,
    speedShift: 0.55,
    drivable: true,
  },
];

export const DRIVABLE_ID = VEHICLE_SETUP.find((v) => v.drivable).id;

// Remote vehicles are the ones the display layer is graded on.
export const REMOTE_IDS = VEHICLE_SETUP.filter((v) => !v.drivable).map((v) => v.id);

export const VEHICLE_BY_ID = new Map(VEHICLE_SETUP.map((v) => [v.id, v]));

export const SERVER_TICK_HZ = 60;
export const SNAPSHOT_HZ = 20;
