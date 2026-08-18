module.exports = {
    "env": {
        "browser": true,
        "es6": false
    },
    "extends": "eslint:recommended",
    "globals": {
        "Atomics": "readonly",
        "SharedArrayBuffer": "readonly",
        // identity.js is loaded both as a browser global and as a CommonJS
        // module (by identity.test.js), so it references `module` behind a
        // `typeof` guard. Declaring it keeps the browser env otherwise strict.
        "module": "readonly"
    },
    "parserOptions": {
        "ecmaVersion": 2018
    },
    "rules": {
    },
    "overrides": [
        {
            // The build script and the tests run in Node, not the browser.
            // Tests use Node's built-in runner (`node --test`).
            "files": ["gulpfile.js", "*.test.js"],
            "env": {
                "browser": false,
                "node": true,
                "es6": true
            }
        }
    ]
};
