const path = require('path');
const webpack = require('webpack');

// The client installs the tarball as-is (no npm install), so every dependency is bundled into
// dist/main.js.
module.exports = {
  entry: './src/index.js',
  target: 'node18',
  output: {
    path: path.join(__dirname, 'dist'),
    filename: 'main.js',
    clean: true,
  },
  plugins: [
    // Native builds of bufferutil/utf-8-validate cannot be bundled. The modules themselves must
    // stay: the websocket library requires them unconditionally and they fall back to plain JS.
    new webpack.IgnorePlugin({ resourceRegExp: /.*\/build\/.*\/(validation|bufferutil)/ }),
  ],
  devtool: 'source-map',
  optimization: {
    // Readable stack traces in the extension error log
    minimize: false,
  },
};
