// The G1 marker of ADR 0001 (D0: the first sidebar link to a bot's thread,
// `a[href*="/bot/"]`, attached and visible), read from outside the app
// through the accessibility tree of its WKWebView: the signed app has no
// remote debugging port, and the measure must not need a hook in it.
//
//   ax-marker --pid N [--timeout-ms 60000] [--interval-ms 10] [--press TITLE]
//
// Prints one JSON line: {"found":true,"epochMs":…,"polls":…,"url":…} as soon
// as a visible link whose URL holds "/bot/" exists (epochMs = wall clock at
// the poll that saw it), then, with --press, presses the link whose title
// holds TITLE (or the first one) and prints {"pressed":…}. Exit 1 on timeout.
// Needs the Accessibility permission for the process that runs it.
import ApplicationServices
import Foundation

func argument(_ name: String) -> String? {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
  return args[index + 1]
}

guard let pidText = argument("--pid"), let pid = pid_t(pidText) else {
  FileHandle.standardError.write("usage: ax-marker --pid N [--timeout-ms N] [--interval-ms N] [--press TITLE]\n".data(using: .utf8)!)
  exit(2)
}
let timeoutMs = Double(argument("--timeout-ms") ?? "60000") ?? 60000
let intervalMs = Double(argument("--interval-ms") ?? "10") ?? 10
let pressTitle = argument("--press")
let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 1.0)

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
  var value: AnyObject?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func string(_ element: AXUIElement, _ name: String) -> String? {
  attribute(element, name) as? String
}

func url(_ element: AXUIElement) -> String? {
  if let value = attribute(element, kAXURLAttribute as String) {
    if let link = value as? URL { return link.absoluteString }
    if let text = value as? String { return text }
  }
  return nil
}

/// The WKWebView's web area, breadth first under the app's windows.
func webArea() -> AXUIElement? {
  guard let windows = attribute(app, kAXWindowsAttribute as String) as? [AXUIElement] else { return nil }
  var queue = windows
  var seen = 0
  while !queue.isEmpty && seen < 400 {
    let element = queue.removeFirst()
    seen += 1
    if string(element, kAXRoleAttribute as String) == "AXWebArea" { return element }
    if let children = attribute(element, kAXChildrenAttribute as String) as? [AXUIElement] { queue.append(contentsOf: children) }
  }
  return nil
}

/// The visible links of the page, by WebKit's own search (what VoiceOver's rotor uses).
func visibleLinks(_ area: AXUIElement) -> [AXUIElement] {
  let predicate: [String: Any] = [
    "AXSearchKey": "AXLinkSearchKey",
    "AXResultsLimit": 200,
    "AXDirection": "AXDirectionNext",
    "AXVisibleOnly": true,
  ]
  var value: AnyObject?
  let status = AXUIElementCopyParameterizedAttributeValue(area, "AXUIElementsForSearchPredicate" as CFString, predicate as CFDictionary, &value)
  guard status == .success, let links = value as? [AXUIElement] else { return [] }
  return links
}

func title(_ element: AXUIElement) -> String {
  [kAXTitleAttribute as String, kAXDescriptionAttribute as String, kAXValueAttribute as String]
    .compactMap { string(element, $0) }
    .joined(separator: " ")
}

func emit(_ object: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
  fflush(stdout)
}

let started = Date()
var polls = 0
while Date().timeIntervalSince(started) * 1000 < timeoutMs {
  polls += 1
  if let area = webArea() {
    let links = visibleLinks(area).filter { url($0)?.contains("/bot/") == true }
    if let first = links.first {
      let seenAt = Date().timeIntervalSince1970 * 1000
      emit(["found": true, "epochMs": seenAt, "polls": polls, "url": url(first) ?? ""])
      if let wanted = pressTitle {
        let target = links.first { title($0).localizedCaseInsensitiveContains(wanted) } ?? first
        let pressed = AXUIElementPerformAction(target, kAXPressAction as CFString) == .success
        emit(["pressed": pressed, "url": url(target) ?? "", "title": title(target)])
      }
      exit(0)
    }
  }
  usleep(useconds_t(intervalMs * 1000))
}
emit(["found": false, "polls": polls])
exit(1)
