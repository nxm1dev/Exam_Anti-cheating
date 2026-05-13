const path = require("path");
const webpack = require("webpack");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");

module.exports = {
  entry: "./src/index.tsx",
  output: {
    path: path.resolve(__dirname, "dist/renderer"),
    filename: "bundle.js",
    publicPath: "./",
    globalObject: "globalThis",
  },
  resolve: {
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    fallback: {
      fs: false,
      path: false,
      crypto: false,
    },
  },
  module: {
    unknownContextCritical: false,
    exprContextCritical: false,
    rules: [
      {
        test: /\.(ts|tsx)$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader"],
      },
    ],
  },
  plugins: [
    new webpack.ProvidePlugin({
      global: "globalThis",
    }),
    new webpack.DefinePlugin({
      global: "globalThis",
    }),
    new HtmlWebpackPlugin({
      template: "./src/index.html",
    }),
    new CopyWebpackPlugin({
      patterns: [
        // VAD ONNX models
        {
          from: "node_modules/@ricky0123/vad-web/dist/*.onnx",
          to: "[name][ext]",
        },
        // VAD worklet
        {
          from: "node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js",
          to: "[name][ext]",
        },
        // Copy standard WASM and MJS files from onnxruntime-web
        {
          from: "node_modules/onnxruntime-web/dist/*.wasm",
          to: "[name][ext]",
        },
        {
          from: "node_modules/onnxruntime-web/dist/*.mjs",
          to: "[name][ext]",
        },
      ],
    }),
  ],
  devServer: {
    port: 3000,
    historyApiFallback: true,
    hot: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  target: "web",
};
