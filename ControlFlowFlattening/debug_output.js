function f_main(T = {
  ["o"]: {}
}, U, V) {
  let state = 0;
  for (;;) {
    switch (state) {
      case 0:
        {
          [T["o"]["o"]] = [-39];
          T["o"]["d"] = function (...S) {
            return f_1({
              ["o"]: T["o"],
              ["E"]: {}
            }, U, S);
          };
          T["o"]["c"] = function (...S) {
            return f_2({
              ["o"]: T["o"],
              ["r"]: {}
            }, U, S);
          };
          T["o"]["b"] = function (...S) {
            return f_3({
              ["o"]: T["o"],
              ["q"]: {}
            }, U, S);
          };
          T["o"]["a"] = function (...S) {
            return f_4({
              ["o"]: T["o"],
              ["p"]: {}
            }, U, S);
          };
          T["o"]["e"] = document["getElementById"]("myCanvas");
          T["o"]["f"] = T["o"]["e"]["getContext"]("2d");
          state = 1;
          break;
        }
      case 1:
        {
          T["o"]["f"]["font"] = "bold 30px sans-serif";
          T["o"]["g"] = undefined;
          T["o"]["h"] = undefined;
          T["o"]["i"] = undefined;
          state = 2;
          break;
        }
      case 2:
        {
          T["o"]["j"] = undefined;
          T["o"]["k"] = 5;
          T["o"]["l"] = 50;
          T["o"]["m"] = [];
          T["o"]["m"][0] = {
            ["x"]: 300,
            ["y"]: 300,
            ["width"]: 200
          };
          state = 3;
          break;
        }
      case 3:
        {
          T["o"]["n"] = {
            ["x"]: 0,
            ["width"]: 0
          };
          T["o"]["e"]["onpointerdown"] = function () {
            if (T["o"]["i"] == "gameOver") {
              (1, T["o"]["d"])();
            } else {
              if (T["o"]["i"] == "bounce") {
                T["o"]["i"] = "fall";
              }
            }
          };
          state = 4;
          break;
        }
      case 4:
        {
          (1, T["o"]["d"])();
          return (1, T["o"]["c"])();
        }
    }
  }
}
function f_1(T = {
  ["o"]: {}
}, U, V) {
  let state = 0;
  for (;;) {
    switch (state) {
      case 0:
        {
          T["E"]["a"] = function (...S) {
            return f_5({
              ["E"]: T["E"],
              ["o"]: T["o"],
              ["F"]: {}
            }, U, S);
          };
          T["E"]["b"] = undefined;
          T["E"]["c"] = (1, T["E"]["a"])([186, 336, -181, -219]);
          if (T["E"]["b"]) {
            state = 2;
          } else {
            state = 1;
          }
          break;
        }
      case 1:
        {
          return undefined;
        }
      case 2:
        {
          return T["E"]["c"];
        }
    }
  }
}
function f_2(T = {
  ["o"]: {}
}, U, V) {
  let state = 0;
  for (;;) {
    switch (state) {
      case 0:
        {
          if (T["o"]["i"] != "gameOver") {
            state = 2;
          } else {
            state = 1;
          }
          break;
        }
      case 1:
        {
          window["requestAnimationFrame"](T["o"]["c"]);
          return undefined;
        }
      case 2:
        {
          T["o"]["f"]["fillStyle"] = "lightblue";
          T["o"]["f"]["fillRect"](0, 0, T["o"]["e"]["width"], T["o"]["e"]["height"]);
          state = 3;
          break;
        }
      case 3:
        {
          T["o"]["f"]["fillStyle"] = "black";
          T["o"]["f"]["fillText"]("Score: " + (current - 1)["toString"](), 100, 200);
          state = 4;
          break;
        }
      case 4:
        {
          for (let W = 0; W < T["o"]["m"]["length"]; W++) {
            let X = T["o"]["m"][W];
            T["o"]["f"]["fillStyle"] = "rgb(" + W * 16 + "," + W * 16 + "," + W * 16 + ")";
            T["o"]["f"]["fillRect"](X["x"], 600 - X["y"] + cameraY, X["width"], T["o"]["l"]);
          }
          T["o"]["f"]["fillStyle"] = "red";
          T["o"]["f"]["fillRect"](T["o"]["n"]["x"], 600 - T["o"]["n"]["y"] + cameraY, T["o"]["n"]["width"], T["o"]["l"]);
          if (T["o"]["i"] == "bounce") {
            state = 22;
          } else {
            state = 5;
          }
          break;
        }
      case 5:
        {
          if (T["o"]["i"] == "fall") {
            state = 9;
          } else {
            state = 6;
          }
          break;
        }
      case 6:
        {
          T["o"]["n"]["y"] = T["o"]["n"]["y"] - T["o"]["k"];
          if (T["o"]["g"]) {
            state = 8;
          } else {
            state = 7;
          }
          break;
        }
      case 7:
        {
          state = 1;
          break;
        }
      case 8:
        {
          cameraY++;
          T["o"]["g"]--;
          state = 7;
          break;
        }
      case 9:
        {
          T["o"]["m"][current]["y"] = T["o"]["m"][current]["y"] - T["o"]["k"];
          if (T["o"]["m"][current]["y"] == T["o"]["m"][current - 1]["y"] + T["o"]["l"]) {
            state = 11;
          } else {
            state = 10;
          }
          break;
        }
      case 10:
        {
          state = 6;
          break;
        }
      case 11:
        {
          T["x"] = {};
          T["o"]["i"] = "bounce";
          T["x"]["a"] = T["o"]["m"][current]["x"] - T["o"]["m"][current - 1]["x"];
          if (Math["abs"](T["x"]["a"]) >= T["o"]["m"][current]["width"]) {
            state = 21;
          } else {
            state = 12;
          }
          break;
        }
      case 12:
        {
          T["o"]["n"] = {
            ["y"]: T["o"]["m"][current]["y"],
            ["width"]: T["x"]["a"]
          };
          if (T["o"]["m"][current]["x"] > T["o"]["m"][current - 1]["x"]) {
            state = 20;
          } else {
            state = 13;
          }
          break;
        }
      case 13:
        {
          T["o"]["n"]["x"] = T["o"]["m"][current]["x"] - T["x"]["a"];
          T["o"]["m"][current]["width"] = T["o"]["m"][current]["width"] + T["x"]["a"];
          state = 14;
          break;
        }
      case 14:
        {
          T["o"]["m"][current]["x"] = T["o"]["m"][current - 1]["x"];
          state = 15;
          break;
        }
      case 15:
        {
          if (T["o"]["j"] > 0) {
            state = 19;
          } else {
            state = 16;
          }
          break;
        }
      case 16:
        {
          T["o"]["j"]--;
          state = 17;
          break;
        }
      case 17:
        {
          current++;
          T["o"]["g"] = T["o"]["l"];
          state = 18;
          break;
        }
      case 18:
        {
          (1, T["o"]["a"])();
          state = 10;
          break;
        }
      case 19:
        {
          T["o"]["j"]++;
          state = 17;
          break;
        }
      case 20:
        {
          T["o"]["m"][current]["width"] = T["o"]["m"][current]["width"] - T["x"]["a"];
          T["o"]["n"]["x"] = T["o"]["m"][current]["x"] + T["o"]["m"][current]["width"];
          state = 15;
          break;
        }
      case 21:
        {
          (1, T["o"]["b"])();
          state = 12;
          break;
        }
      case 22:
        {
          T["o"]["m"][current]["x"] = T["o"]["m"][current]["x"] + T["o"]["j"];
          if (T["o"]["j"] > 0 && T["o"]["m"][current]["x"] + T["o"]["m"][current]["width"] > T["o"]["e"]["width"]) {
            state = 26;
          } else {
            state = 23;
          }
          break;
        }
      case 23:
        {
          if (T["o"]["j"] < 0 && T["o"]["m"][current]["x"] < 0) {
            state = 25;
          } else {
            state = 24;
          }
          break;
        }
      case 24:
        {
          state = 5;
          break;
        }
      case 25:
        {
          T["o"]["j"] = -T["o"]["j"];
          state = 24;
          break;
        }
      case 26:
        {
          T["o"]["j"] = -T["o"]["j"];
          state = 23;
          break;
        }
    }
  }
}
function f_3(T = {
  ["o"]: {}
}, U, V) {
  let state = 0;
  for (;;) {
    switch (state) {
      case 0:
        {
          T["o"]["i"] = "gameOver";
          T["o"]["f"]["fillText"]("Game over. Click to play again!", 50, 50);
          state = 1;
          break;
        }
      case 1:
        {
          return undefined;
        }
    }
  }
}
function f_4(T = {
  ["o"]: {}
}, U, V) {
  let state = 0;
  for (;;) {
    switch (state) {
      case 0:
        {
          T["o"]["m"][current] = {
            ["x"]: 0,
            ["y"]: (current + 10) * T["o"]["l"],
            ["width"]: T["o"]["m"][current - 1]["width"]
          };
          return undefined;
        }
    }
  }
}
function f_5(T = {
  ["o"]: {}
}, U, V) {
  let state = 0;
  for (;;) {
    switch (state) {
      case 0:
        {
          [T["F"]["a"], T["F"]["b"] = {
            ["g"]: {}
          }, T["F"]["c"]] = V;
          [T["F"]["b"]["g"]["a"], T["F"]["b"]["g"]["b"], T["F"]["b"]["g"]["c"]] = [55, 237, -120];
          T["o"]["m"]["splice"](1, T["o"]["m"]["length"] - 1);
          T["o"]["i"] = "bounce";
          cameraY = 0;
          T["o"]["g"] = 0;
          T["o"]["j"] = 2;
          current = 1;
          (1, T["o"]["a"])();
          T["o"]["n"]["y"] = 0;
          return undefined;
        }
    }
  }
}
f_main();