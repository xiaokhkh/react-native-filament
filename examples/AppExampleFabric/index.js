import { AppRegistry } from 'react-native'
import { configureReanimatedLogger, ReanimatedLogLevel } from 'react-native-reanimated'
import { name as appName } from './app.json'

import { version } from 'react-native-worklets-core/package.json'
console.log(`Using react-native-worklets-core@${version}`)

// Setup a logger for filament
import { setLogger } from 'react-native-filament'
// A function that can wrap a console log call to add a prefix
const prefix = '[filament-logger]'
const prefixLog =
  (logFn) =>
  (...messages) => {
    const date = new Date()
    logFn(prefix, `[${date.toLocaleTimeString()} ${date.getMilliseconds().toString().padStart(3, 0)}]`, ...messages)
  }
setLogger({
  debug: prefixLog(console.debug),
  log: prefixLog(console.log),
  info: prefixLog(console.info),
  warn: prefixLog(console.warn),
  error: prefixLog(console.error),
})

// The upstream example runs native self-tests on startup. Disable them here so the demo
// opens without permanent error snackbars covering the scene.
configureReanimatedLogger({ level: ReanimatedLogLevel.warn, strict: false })

const App = require('shared/src/App').default

AppRegistry.registerComponent(appName, () => App)
