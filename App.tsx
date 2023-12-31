import React, { useEffect, useState, useRef } from "react";
import { StyleSheet, Text, View, Dimensions, Platform } from "react-native";

import { Camera } from "expo-camera";

import * as tf from "@tensorflow/tfjs";
import * as posedetection from "@tensorflow-models/pose-detection";
import * as ScreenOrientation from "expo-screen-orientation";
import {
  bundleResourceIO,
  cameraWithTensors,
} from "@tensorflow/tfjs-react-native";
import Svg, { Circle,Line,Text as TextSVG  } from "react-native-svg";
import { ExpoWebGLRenderingContext } from "expo-gl";
import { CameraType } from "expo-camera/build/Camera.types";

import * as Speech from 'expo-speech';


const connections = [
  { from: 0, to: 1 }, // nose to left eye
  { from: 0, to: 2 }, // nose to right eye
  { from: 1, to: 3 }, // left eye to left ear
  { from: 2, to: 4 }, // right eye to right ear
  { from: 5, to: 6 }, // left shoulder to right shoulder
  { from: 5, to: 7 }, // left shoulder to left elbow
  { from: 6, to: 8 }, // right shoulder to right elbow
  { from: 7, to: 9 }, // left elbow to left wrist
  { from: 8, to: 10 }, // right elbow to right wrist
  { from: 5, to: 11 }, // left shoulder to left hip
  { from: 6, to: 12 }, // right shoulder to right hip
  { from: 11, to: 12 }, // left hip to right hip
  { from: 11, to: 13 }, // left hip to left knee
  { from: 12, to: 14 }, // right hip to right knee
  { from: 13, to: 15 }, // left knee to left ankle
  { from: 14, to: 16 }, // right knee to right ankle
];
// tslint:disable-next-line: variable-name
const TensorCamera = cameraWithTensors(Camera);

const IS_ANDROID = Platform.OS === "android";
const IS_IOS = Platform.OS === "ios";

// Camera preview size.
//
// From experiments, to render camera feed without distortion, 16:9 ratio
// should be used fo iOS devices and 4:3 ratio should be used for android
// devices.
//
// This might not cover all cases.
const CAM_PREVIEW_WIDTH = Dimensions.get("window").width;
const CAM_PREVIEW_HEIGHT = CAM_PREVIEW_WIDTH / (IS_IOS ? 9 / 16 : 3 / 4);

// The score threshold for pose detection results.
const MIN_KEYPOINT_SCORE = 0.3;

// The size of the resized output from TensorCamera.
//
// For movenet, the size here doesn't matter too much because the model will
// preprocess the input (crop, resize, etc). For best result, use the size that
// doesn't distort the image.
const OUTPUT_TENSOR_WIDTH = 180;
const OUTPUT_TENSOR_HEIGHT = OUTPUT_TENSOR_WIDTH / (IS_IOS ? 9 / 16 : 3 / 4);

// Whether to auto-render TensorCamera preview.
const AUTO_RENDER = false;

// Whether to load model from app bundle (true) or through network (false).
const LOAD_MODEL_FROM_BUNDLE = false;
let isSpeaking = false; // Track the speaking state

const speak = (text) => {
  if (!isSpeaking) {
    isSpeaking = true;
    Speech.speak(text, {
      onDone: () => {
        isSpeaking = false; // Reset the speaking state when speech is done
      },
    });
  }
};

export default function App() {
  const cameraRef = useRef(null);
  const [tfReady, setTfReady] = useState(false);
  const [model, setModel] = useState<posedetection.PoseDetector>();
  const [poses, setPoses] = useState<posedetection.Pose[]>();
  const [fps, setFps] = useState(0);
  const [orientation, setOrientation] =
    useState<ScreenOrientation.Orientation>();
  const [cameraType, setCameraType] = useState<CameraType>(
    Camera.Constants.Type.front
  );
  // Use `useRef` so that changing it won't trigger a re-render.
  //
  // - null: unset (initial value).
  // - 0: animation frame/loop has been canceled.
  // - >0: animation frame has been scheduled.
  const rafId = useRef<number | null>(null);
  //Prepare Function
  useEffect(() => {
    async function prepare() {
      rafId.current = null;

      // Set initial orientation.
      const curOrientation = await ScreenOrientation.getOrientationAsync();
      setOrientation(curOrientation);

      // Listens to orientation change.
      ScreenOrientation.addOrientationChangeListener((event) => {
        setOrientation(event.orientationInfo.orientation);
      });

      // Camera permission.
      await Camera.requestCameraPermissionsAsync();

      // Wait for tfjs to initialize the backend.
      await tf.ready();

      // Load movenet model. SINGLEPOSE_LIGHTNING
      // https://github.com/tensorflow/tfjs-models/tree/master/pose-detection
      const movenetModelConfig: posedetection.MoveNetModelConfig = {
        modelType: posedetection.movenet.modelType.SINGLEPOSE_THUNDER,
        enableSmoothing: true,
      };
      if (LOAD_MODEL_FROM_BUNDLE) {
        const modelJson = require("./offline_model/model.json");
        const modelWeights1 = require("./offline_model/group1-shard1of2.bin");
        const modelWeights2 = require("./offline_model/group1-shard2of2.bin");
        movenetModelConfig.modelUrl = bundleResourceIO(modelJson, [
          modelWeights1,
          modelWeights2,
        ]);
      }
      const model = await posedetection.createDetector(
        posedetection.SupportedModels.MoveNet,
        movenetModelConfig
      );
      setModel(model);

      // Ready!
      setTfReady(true);
    }

    prepare();
  }, []);

  useEffect(() => {
    // Called when the app is unmounted.
    return () => {
      if (rafId.current != null && rafId.current !== 0) {
        cancelAnimationFrame(rafId.current);
        rafId.current = 0;
      }
    };
  }, []);

  const handleCameraStream = async (
    images: IterableIterator<tf.Tensor3D>,
    updatePreview: () => void,
    gl: ExpoWebGLRenderingContext
  ) => {
    const loop = async () => {
      // Get the tensor and run pose detection.
      const imageTensor = images.next().value as tf.Tensor3D;

      const startTs = Date.now();
      const poses = await model!.estimatePoses(
        imageTensor,
        undefined,
        Date.now()
      );
      const latency = Date.now() - startTs;
      setFps(Math.floor(1000 / latency));
      setPoses(poses);
      tf.dispose([imageTensor]);

      if (rafId.current === 0) {
        return;
      }

      // Render camera preview manually when autorender=false.
      if (!AUTO_RENDER) {
        updatePreview();
        gl.endFrameEXP();
      }

      rafId.current = requestAnimationFrame(loop);
    };

    loop();
  };

  const renderPose = () => {
    if (poses != null && poses.length > 0) {
      const keypoints = poses[0].keypoints
        .filter((k) => (k.score ?? 0) > MIN_KEYPOINT_SCORE)
        .map((k) => {
          // Flip horizontally on android or when using back camera on iOS.
          const flipX = IS_ANDROID || cameraType === Camera.Constants.Type.back;
          const x = flipX ? getOutputTensorWidth() - k.x : k.x;
          const y = k.y;
          const cx =
            (x / getOutputTensorWidth()) *
            (isPortrait() ? CAM_PREVIEW_WIDTH : CAM_PREVIEW_HEIGHT);
          const cy =
            (y / getOutputTensorHeight()) *
            (isPortrait() ? CAM_PREVIEW_HEIGHT : CAM_PREVIEW_WIDTH);
          return (
            <Circle
              key={`skeletonkp_${k.name}`}
              cx={cx}
              cy={cy}
              r="4"
              strokeWidth="2"
              fill="#00AA00"
              stroke="white"
            />
          );
        });

      // Define the connections based on the keypoints order


// Assuming 'keypoints' is an array of your <Circle> components representing the keypoints
// console.log("Keypoints array:", keypoints);

// const lines = connections.map((connection, index) => {
//   const startCircle = keypoints[connection.from];
//   const endCircle = keypoints[connection.to];

//   if (!startCircle || !endCircle) {
//     // console.warn(`Undefined Circle element at index: from=${connection.from}, to=${connection.to}`);
//     return null; // Skip rendering this line if the keypoints are not found
//   }

//   // console.log(`Line ${index} startCircle:`, startCircle);
//   // console.log(`Line ${index} endCircle:`, endCircle);

//   // Extract the cx and cy attributes from the props of the Circle components
//   const { cx: startX, cy: startY } = startCircle.props;
//   const { cx: endX, cy: endY } = endCircle.props;

//   return (
//     <Line
//       key={`line_${index}`}
//       x1={startX}
//       y1={startY}
//       x2={endX}
//       y2={endY}
//       stroke="#FFFFFF"
//       strokeWidth="2"
//     />
//   );
// });
// // Filter out any null elements before rendering
// const validLines = lines.filter(line => line != null);

//calculate the angle bewteen arm and the body
const leftShoulder = keypoints[5];
const rightShoulder = keypoints[6];
const rightElbow = keypoints[8];
const leftHip = keypoints[11];
const rightHip = keypoints[12];
const leftKnee = keypoints[13];
const rightKnee = keypoints[14];
//
function calculateAngle(A, B, C) {
  const AB = { x: B.x - A.x, y: B.y - A.y };
  const BC = { x: C.x - B.x, y: C.y - B.y };

  const dotProduct = (AB.x * BC.x) + (AB.y * BC.y);
  const magnitudeAB = Math.sqrt(AB.x * AB.x + AB.y * AB.y);
  const magnitudeBC = Math.sqrt(BC.x * BC.x + BC.y * BC.y);
  const angle = Math.acos(dotProduct / (magnitudeAB * magnitudeBC));

  return angle * (180 / Math.PI); // convert radians to degrees
}
// console.log(rightAnkle);
// Extract the coordinates from the keypoints
var angleText = "0°";
var angleTextPosition = { x: 0, y: 0 };``


let shoulderPoint, kneePoint, hipPoint;

// Check if the right side points are available
if (rightShoulder && rightKnee && rightHip) {
  shoulderPoint = { x: rightShoulder.props.cx, y: rightShoulder.props.cy };
  kneePoint = { x: rightKnee.props.cx, y: rightKnee.props.cy };
  hipPoint = { x: rightHip.props.cx, y: rightHip.props.cy };
}

// Check if the left side points are available and right side is not available
else if (leftShoulder && leftKnee && leftHip) {
  shoulderPoint = { x: leftShoulder.props.cx, y: leftShoulder.props.cy };
  kneePoint = { x: leftKnee.props.cx, y: leftKnee.props.cy };
  hipPoint = { x: leftHip.props.cx, y: leftHip.props.cy };
}

// If we have a complete set of points,r calculate the angle
if (shoulderPoint && kneePoint && hipPoint) {
  const backAngle = calculateAngle(shoulderPoint, kneePoint, hipPoint);

  if(backAngle<160){

    speak('Please do not bend your back');
  }else {
    if (isSpeaking) {
      Speech.stop(); // Stop speech if angle is below 160
      isSpeaking = false; // Reset the speaking state
    }
  }

  angleText = `${backAngle.toFixed(2)}°`;
// Choose a suitable position for the text on the SVG
  angleTextPosition = {
    x: (shoulderPoint.x + hipPoint.x) / 2,
    y: (shoulderPoint.y + hipPoint.y) / 2
  };
}


// {validLines}


return (
  
  <Svg style={styles.svg}>
    <TextSVG
      x={angleTextPosition.x} 
      y={angleTextPosition.y}
      fill="#ff0000"
      fontSize="25"
      textAnchor="middle">
      {angleText}
      </TextSVG>


    {keypoints}
  </Svg>
);
    } else {
      return <View>

      </View>;
    }
  };

  const renderFps = () => {
    return (
      <View style={styles.fpsContainer}>
        <Text>FPS: {fps}</Text>
      </View>
    );
  };

  const renderCameraTypeSwitcher = () => {
    return (
      <View
        style={styles.cameraTypeSwitcher}
        onTouchEnd={handleSwitchCameraType}
      >
        <Text>
          Switch to{" "}
          {cameraType === Camera.Constants.Type.front ? "back" : "front"} camera
        </Text>
      </View>
    );
  };

  const handleSwitchCameraType = () => {
    if (cameraType === Camera.Constants.Type.front) {
      setCameraType(Camera.Constants.Type.back);
    } else {
      setCameraType(Camera.Constants.Type.front);
    }
  };

  const isPortrait = () => {
    return (
      orientation === ScreenOrientation.Orientation.PORTRAIT_UP ||
      orientation === ScreenOrientation.Orientation.PORTRAIT_DOWN
    );
  };

  const getOutputTensorWidth = () => {
    // On iOS landscape mode, switch width and height of the output tensor to
    // get better result. Without this, the image stored in the output tensor
    // would be stretched too much.
    //
    // Same for getOutputTensorHeight below.
    return isPortrait() || IS_ANDROID
      ? OUTPUT_TENSOR_WIDTH
      : OUTPUT_TENSOR_HEIGHT;
  };

  const getOutputTensorHeight = () => {
    return isPortrait() || IS_ANDROID
      ? OUTPUT_TENSOR_HEIGHT
      : OUTPUT_TENSOR_WIDTH;
  };

  const getTextureRotationAngleInDegrees = () => {
    // On Android, the camera texture will rotate behind the scene as the phone
    // changes orientation, so we don't need to rotate it in TensorCamera.
    if (IS_ANDROID) {
      return 0;
    }

    // For iOS, the camera texture won't rotate automatically. Calculate the
    // rotation angles here which will be passed to TensorCamera to rotate it
    // internally.
    switch (orientation) {
      // Not supported on iOS as of 11/2021, but add it here just in case.
      case ScreenOrientation.Orientation.PORTRAIT_DOWN:
        return 180;
      case ScreenOrientation.Orientation.LANDSCAPE_LEFT:
        return cameraType === Camera.Constants.Type.front ? 270 : 90;
      case ScreenOrientation.Orientation.LANDSCAPE_RIGHT:
        return cameraType === Camera.Constants.Type.front ? 90 : 270;
      default:
        return 0;
    }
  };

  if (!tfReady) {
    return (
      <View style={styles.loadingMsg}>
        <Text>Loading...</Text>
      </View>
    );
  } else {
    return (
      // Note that you don't need to specify `cameraTextureWidth` and
      // `cameraTextureHeight` prop in `TensorCamera` below.
      <View
        style={
          isPortrait() ? styles.containerPortrait : styles.containerLandscape
        }
      >
        <TensorCamera
          ref={cameraRef}
          style={styles.camera}
          autorender={AUTO_RENDER}
          type={cameraType}
          // tensor related props
          resizeWidth={getOutputTensorWidth()}
          resizeHeight={getOutputTensorHeight()}
          resizeDepth={3}
          rotation={getTextureRotationAngleInDegrees()}
          onReady={handleCameraStream}
        />
        {renderPose()}
        {renderFps()}
        {renderCameraTypeSwitcher()}
      </View>
    );
  }
}

const styles = StyleSheet.create({
  containerPortrait: {
    position: "relative",
    width: CAM_PREVIEW_WIDTH,
    height: CAM_PREVIEW_HEIGHT,
    marginTop: Dimensions.get("window").height / 2 - CAM_PREVIEW_HEIGHT / 2,
  },
  containerLandscape: {
    position: "relative",
    width: CAM_PREVIEW_HEIGHT,
    height: CAM_PREVIEW_WIDTH,
    marginLeft: Dimensions.get("window").height / 2 - CAM_PREVIEW_HEIGHT / 2,
  },
  loadingMsg: {
    position: "absolute",
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  camera: {
    width: "100%",
    height: "100%",
    zIndex: 1,
  },
  svg: {
    width: "100%",
    height: "100%",
    position: "absolute",
    zIndex: 30,
  },
  fpsContainer: {
    position: "absolute",
    top: 10,
    left: 10,
    width: 80,
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, .7)",
    borderRadius: 2,
    padding: 8,
    zIndex: 20,
  },
  cameraTypeSwitcher: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 180,
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, .7)",
    borderRadius: 2,
    padding: 8,
    zIndex: 20,
  },
});
