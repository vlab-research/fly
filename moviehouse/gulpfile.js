const gulp = require('gulp');
const mustache = require('gulp-mustache');
require('dotenv').config();

// The src list is explicit rather than a glob so that `src/identity.test.js` is
// never shipped to `dist`. identity.js has no mustache placeholders; the pipe is
// a passthrough for it.
gulp.task('replace', function() {
  return gulp.src(['./src/identity.js', './src/script.js', './src/index.html', './src/style.css'])
    .pipe(mustache(process.env))
    .pipe(gulp.dest('./dist'))
});