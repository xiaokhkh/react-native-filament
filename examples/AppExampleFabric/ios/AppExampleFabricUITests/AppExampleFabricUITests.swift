import XCTest

final class AppExampleFabricUITests: XCTestCase {
  private struct Pose {
    let x: Double
    let z: Double
    let hit: Int
  }

  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  func testIntegratedDemoRoutesSmoke() throws {
    let app = XCUIApplication()
    app.launch()
    let surface = app.windows.firstMatch
    XCTAssertTrue(surface.waitForExistence(timeout: 30))
    sleep(5)
    try saveScreenshot(named: "rnf_integrated_spz_leona")
    let leonaPose = app.staticTexts["spz-leona-pose"]
    XCTAssertTrue(leonaPose.waitForExistence(timeout: 10))
    let leonaBeforeMove = try parsePose(leonaPose.label)
    tapGround(on: surface)
    sleep(2)
    let leonaAfterTap = try parsePose(leonaPose.label)
    XCTAssertGreaterThan(distance(from: leonaBeforeMove, to: leonaAfterTap), 0.25)

    tapGround(on: surface, at: CGVector(dx: 0.62, dy: 0.62))
    sleep(2)
    let leonaAfterSecondTap = try parsePose(leonaPose.label)
    XCTAssertGreaterThan(distance(from: leonaAfterTap, to: leonaAfterSecondTap), 0.18)

    drag(on: surface, from: CGVector(dx: 0.18, dy: 0.78), to: CGVector(dx: 0.18, dy: 0.54), duration: 1.1)
    sleep(1)
    let leonaAfterMove = try parsePose(leonaPose.label)
    XCTAssertLessThan(leonaAfterMove.z, leonaAfterSecondTap.z - 0.5)

    pushLeonaForward(on: surface, repeatCount: 4)
    sleep(1)
    let leonaAtForwardLimit = try parsePose(leonaPose.label)
    pushLeonaForward(on: surface, repeatCount: 2)
    sleep(1)
    let leonaAfterForwardRepeat = try parsePose(leonaPose.label)
    XCTAssertGreaterThan(leonaAtForwardLimit.z, -13.3)
    assertClose(leonaAfterForwardRepeat.z, leonaAtForwardLimit.z, tolerance: 0.16)

    pushLeonaRight(on: surface, repeatCount: 5)
    sleep(1)
    let leonaAtRightLimit = try parsePose(leonaPose.label)
    pushLeonaRight(on: surface, repeatCount: 2)
    sleep(1)
    let leonaAfterRightRepeat = try parsePose(leonaPose.label)
    XCTAssertLessThan(leonaAtRightLimit.x, 4.05)
    assertClose(leonaAfterRightRepeat.x, leonaAtRightLimit.x, tolerance: 0.16)

    try saveScreenshot(named: "rnf_integrated_spz_leona_after_move")
  }

  func testForwardCollisionAndLookDrag() throws {
    let harness = try launchHarness()
    let logURL = poseLogURL(named: "forward")
    try? FileManager.default.removeItem(at: logURL)

    let before = try savePose(named: "before", from: harness.pose, to: logURL)
    try saveScreenshot(named: "rnf_spz_forward_before")

    pushForward(on: harness.surface, repeatCount: 1)
    sleep(1)
    let afterForward = try savePose(named: "after_forward", from: harness.pose, to: logURL)
    try saveScreenshot(named: "rnf_spz_forward_after_move")

    pushForward(on: harness.surface, repeatCount: 3)
    sleep(1)
    let afterCollision = try savePose(named: "after_collision_push", from: harness.pose, to: logURL)
    try saveScreenshot(named: "rnf_spz_forward_after_collision")

    pushForward(on: harness.surface, repeatCount: 3)
    sleep(1)
    let afterRepeat = try savePose(named: "after_collision_repeat", from: harness.pose, to: logURL)
    try saveScreenshot(named: "rnf_spz_forward_after_repeat")

    drag(on: harness.surface, from: CGVector(dx: 0.60, dy: 0.30), to: CGVector(dx: 0.60, dy: 0.18), duration: 0.8)
    sleep(1)
    let afterLook = try savePose(named: "after_look", from: harness.pose, to: logURL)
    try saveScreenshot(named: "rnf_spz_forward_after_look")

    XCTAssertGreaterThan(distance(from: before, to: afterForward), 0.5)
    XCTAssertLessThan(afterCollision.z, before.z - 1.2)
    assertClose(afterRepeat.x, afterCollision.x, tolerance: 0.08)
    assertClose(afterRepeat.z, afterCollision.z, tolerance: 0.08)
    assertClose(afterLook.x, afterRepeat.x, tolerance: 0.08)
    assertClose(afterLook.z, afterRepeat.z, tolerance: 0.08)
  }

  func testBarCounterBlocksRightStrafe() throws {
    let harness = try launchHarness()
    let logURL = poseLogURL(named: "bar")
    try? FileManager.default.removeItem(at: logURL)

    _ = try savePose(named: "before", from: harness.pose, to: logURL)

    let inFrontOfBar = try savePose(named: "in_front_of_generated_barrier", from: harness.pose, to: logURL)

    strafeRight(on: harness.surface, repeatCount: 3)
    sleep(1)
    let afterBarHit = try savePose(named: "after_bar_hit", from: harness.pose, to: logURL)
    try saveScreenshot(named: "rnf_spz_bar_after_hit")

    strafeRight(on: harness.surface, repeatCount: 2)
    sleep(1)
    let afterBarRepeat = try savePose(named: "after_bar_repeat", from: harness.pose, to: logURL)
    try saveScreenshot(named: "rnf_spz_bar_after_repeat")

    XCTAssertGreaterThan(afterBarHit.x, inFrontOfBar.x + 0.35)
    XCTAssertLessThan(afterBarHit.x, 1.05)
    XCTAssertLessThan(afterBarRepeat.x, 1.05)
    assertClose(afterBarRepeat.x, afterBarHit.x, tolerance: 0.08)
    assertClose(afterBarRepeat.z, afterBarHit.z, tolerance: 0.08)
  }

  func testGeneratedCollisionBlocksLateralMovement() throws {
    let harness = try launchHarness()
    let logURL = poseLogURL(named: "walls")
    try? FileManager.default.removeItem(at: logURL)

    let before = try savePose(named: "before", from: harness.pose, to: logURL)

    pushForward(on: harness.surface, repeatCount: 1)
    sleep(1)
    let inCorridor = try savePose(named: "in_corridor", from: harness.pose, to: logURL)

    strafeRight(on: harness.surface, repeatCount: 4)
    sleep(1)
    let afterRightWall = try savePose(named: "after_right_wall", from: harness.pose, to: logURL)
    try saveScreenshot(named: "rnf_spz_wall_after_right")

    strafeRight(on: harness.surface, repeatCount: 2)
    sleep(1)
    let afterRightRepeat = try savePose(named: "after_right_repeat", from: harness.pose, to: logURL)

    strafeLeft(on: harness.surface, repeatCount: 7)
    sleep(1)
    let afterLeftWall = try savePose(named: "after_left_wall", from: harness.pose, to: logURL)
    try saveScreenshot(named: "rnf_spz_wall_after_left")

    strafeLeft(on: harness.surface, repeatCount: 2)
    sleep(1)
    let afterLeftRepeat = try savePose(named: "after_left_repeat", from: harness.pose, to: logURL)

    XCTAssertGreaterThan(distance(from: before, to: inCorridor), 1.0)
    XCTAssertGreaterThan(afterRightWall.x, inCorridor.x + 0.35)
    XCTAssertLessThan(afterRightWall.x, 3.9)
    assertClose(afterRightRepeat.x, afterRightWall.x, tolerance: 0.08)
    assertClose(afterRightRepeat.z, afterRightWall.z, tolerance: 0.08)

    XCTAssertLessThan(afterLeftWall.x, afterRightWall.x - 1.2)
    XCTAssertGreaterThan(afterLeftWall.x, -5.2)
    XCTAssertLessThan(afterLeftRepeat.x, afterRightWall.x - 1.2)
    XCTAssertGreaterThan(afterLeftRepeat.x, -5.2)
    assertClose(afterLeftRepeat.x, afterLeftWall.x, tolerance: 0.08)
    assertClose(afterLeftRepeat.z, afterLeftWall.z, tolerance: 0.08)
  }

  private typealias Harness = (app: XCUIApplication, surface: XCUIElement, pose: XCUIElement)

  private func launchHarness() throws -> Harness {
    let app = XCUIApplication()
    app.launch()

    let pose = app.staticTexts["spz-leona-pose"]
    XCTAssertTrue(pose.waitForExistence(timeout: 30))

    let surface = app.windows.firstMatch
    XCTAssertTrue(surface.waitForExistence(timeout: 10))
    return (app, surface, pose)
  }

  private func pushForward(on element: XCUIElement, repeatCount: Int) {
    for _ in 0..<repeatCount {
      drag(on: element, from: CGVector(dx: 0.18, dy: 0.78), to: CGVector(dx: 0.18, dy: 0.54), duration: 1.2)
    }
  }

  private func strafeRight(on element: XCUIElement, repeatCount: Int) {
    for _ in 0..<repeatCount {
      drag(on: element, from: CGVector(dx: 0.18, dy: 0.78), to: CGVector(dx: 0.32, dy: 0.78), duration: 1.2)
    }
  }

  private func strafeLeft(on element: XCUIElement, repeatCount: Int) {
    for _ in 0..<repeatCount {
      drag(on: element, from: CGVector(dx: 0.18, dy: 0.78), to: CGVector(dx: 0.04, dy: 0.78), duration: 1.2)
    }
  }

  private func pushLeonaForward(on element: XCUIElement, repeatCount: Int) {
    for _ in 0..<repeatCount {
      drag(on: element, from: CGVector(dx: 0.18, dy: 0.78), to: CGVector(dx: 0.18, dy: 0.54), duration: 1.1)
    }
  }

  private func pushLeonaRight(on element: XCUIElement, repeatCount: Int) {
    for _ in 0..<repeatCount {
      drag(on: element, from: CGVector(dx: 0.18, dy: 0.78), to: CGVector(dx: 0.32, dy: 0.78), duration: 1.1)
    }
  }

  private func tapGround(on element: XCUIElement, at offset: CGVector = CGVector(dx: 0.34, dy: 0.62)) {
    element.coordinate(withNormalizedOffset: offset).tap()
  }

  private func drag(on element: XCUIElement, from start: CGVector, to end: CGVector, duration: TimeInterval) {
    let startCoordinate = element.coordinate(withNormalizedOffset: start)
    let endCoordinate = element.coordinate(withNormalizedOffset: end)
    startCoordinate.press(forDuration: 0.12, thenDragTo: endCoordinate, withVelocity: .slow, thenHoldForDuration: duration)
  }

  private func saveScreenshot(named name: String) throws {
    let screenshot = XCUIScreen.main.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)

    let url = URL(fileURLWithPath: "/tmp/\(name).png")
    try screenshot.pngRepresentation.write(to: url, options: .atomic)
  }

  private func poseLogURL(named name: String) -> URL {
    URL(fileURLWithPath: "/tmp/rnf_spz_xctest_pose_\(name).txt")
  }

  private func savePose(named name: String, from element: XCUIElement, to url: URL) throws -> Pose {
    let pose = try parsePose(element.label)
    let line = "\(name): \(element.label)\n"
    if !FileManager.default.fileExists(atPath: url.path) {
      FileManager.default.createFile(atPath: url.path, contents: nil)
    }
    let handle = try FileHandle(forWritingTo: url)
    try handle.seekToEnd()
    try handle.write(contentsOf: Data(line.utf8))
    try handle.close()
    return pose
  }

  private func parsePose(_ label: String) throws -> Pose {
    var x: Double?
    var z: Double?
    var hit: Int?

    for part in label.split(separator: " ") {
      if part.hasPrefix("x=") {
        x = Double(part.dropFirst(2))
      } else if part.hasPrefix("z=") {
        z = Double(part.dropFirst(2))
      } else if part.hasPrefix("hit=") {
        hit = Int(part.dropFirst(4))
      }
    }

    guard let x, let z, let hit else {
      XCTFail("Unable to parse pose label: \(label)")
      throw NSError(domain: "AppExampleFabricUITests", code: 1)
    }
    return Pose(x: x, z: z, hit: hit)
  }

  private func assertClose(_ actual: Double, _ expected: Double, tolerance: Double, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertLessThanOrEqual(abs(actual - expected), tolerance, "actual=\(actual), expected=\(expected)", file: file, line: line)
  }

  private func distance(from lhs: Pose, to rhs: Pose) -> Double {
    hypot(rhs.x - lhs.x, rhs.z - lhs.z)
  }
}
