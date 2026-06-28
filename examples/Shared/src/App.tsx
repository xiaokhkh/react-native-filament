import React from 'react'
import { LogBox } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import { SpzLeonaWalk } from './integratedDemo/SpzLeonaWalk'

LogBox.ignoreLogs(['InteractionManager has been deprecated', '[Reanimated] Reading from `value` during component render'])

function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SpzLeonaWalk />
    </GestureHandlerRootView>
  )
}

export default App
