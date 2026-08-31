import CoreGraphics
import Foundation

/// The window selected by the public CoreGraphics hit tester.
internal struct WindowTarget: Equatable {
    let windowID: CGWindowID
    let ownerPID: pid_t
    let bounds: CGRect
    let ownerName: String
    /// A higher window overlaps this target, so focusing it must not raise it
    /// above the covering window. This mirrors the policy used by the
    /// SkyLight-backed path: preserve the visible stack while changing the
    /// focused window.
    let requiresNoRaise: Bool

    init(
        windowID: CGWindowID,
        ownerPID: pid_t,
        bounds: CGRect,
        ownerName: String,
        requiresNoRaise: Bool = false
    ) {
        self.windowID = windowID
        self.ownerPID = ownerPID
        self.bounds = bounds
        self.ownerName = ownerName
        self.requiresNoRaise = requiresNoRaise
    }
}

/// The result of testing the window stack at a screen point.
internal enum WindowHitResult: Equatable {
    case target(WindowTarget)
    case blocked
    case none
}

/// A normalized window-list entry. The same value is used by the live and
/// synthetic hit-test paths so the selection policy stays deterministic.
internal struct WindowCandidate: Equatable {
    let windowID: CGWindowID
    let ownerPID: pid_t
    let layer: Int
    let bounds: CGRect
    let ownerName: String

    init(
        windowID: CGWindowID,
        ownerPID: pid_t,
        layer: Int,
        bounds: CGRect,
        ownerName: String
    ) {
        self.windowID = windowID
        self.ownerPID = ownerPID
        self.layer = layer
        self.bounds = bounds
        self.ownerName = ownerName
    }

    var isWindowServer: Bool {
        ownerName == "Window Server"
    }
}

/// Selects the frontmost eligible CoreGraphics window at a point.
internal struct WindowHitTester {
    private static let minimumVisibleFraction: CGFloat = 0.30

    /// Reads the on-screen window list in the order supplied by WindowServer.
    /// `CGWindowListCopyWindowInfo` returns front-to-back entries for this
    /// option set, so the pure overload can apply the same ordering policy.
    func hitTest(at point: CGPoint) -> WindowHitResult {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let info = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return .none
        }

        var displayIDs = [CGDirectDisplayID](repeating: 0, count: 16)
        var displayCount: UInt32 = 0
        let displayResult = CGGetActiveDisplayList(UInt32(displayIDs.count), &displayIDs, &displayCount)
        guard displayResult == .success else {
            return .none
        }

        let displayRects = displayIDs.prefix(Int(displayCount)).map(CGDisplayBounds)
        let candidates = info.compactMap(Self.candidate(from:))
        return Self.hitTest(point: point, candidates: candidates, displayRects: displayRects)
    }

    /// Pure selection policy for tests and callers that already have a
    /// normalized CoreGraphics window snapshot.
    static func hitTest(
        point: CGPoint,
        candidates: [WindowCandidate],
        displayRects: [CGRect]
    ) -> WindowHitResult {
        for (index, candidate) in candidates.enumerated() {
            guard candidate.bounds.contains(point) else {
                continue
            }

            // Window Server entries describe infrastructure rather than an
            // application window and must never become blockers or targets.
            if candidate.isWindowServer {
                continue
            }

            // A visible positive-layer window is a blocker even when most of
            // its frame is parked offscreen. Applying the target visibility
            // threshold first would tunnel through a small visible portion of
            // a password prompt or floating panel.
            if candidate.layer > 0 {
                return .blocked
            }

            guard candidate.layer == 0,
                isEligible(candidate, displayRects: displayRects)
            else { continue }

            return .target(WindowTarget(
                windowID: candidate.windowID,
                ownerPID: candidate.ownerPID,
                bounds: candidate.bounds,
                ownerName: candidate.ownerName,
                requiresNoRaise: isCovered(
                    candidate,
                    by: candidates[..<index]
                )
            ))
        }

        return .none
    }

    private static func candidate(from info: [String: Any]) -> WindowCandidate? {
        guard
            let windowID = (info[kCGWindowNumber as String] as? NSNumber).map({ CGWindowID($0.uint32Value) }),
            let ownerPID = (info[kCGWindowOwnerPID as String] as? NSNumber).map({ pid_t($0.int32Value) }),
            let layer = (info[kCGWindowLayer as String] as? NSNumber)?.intValue,
            let bounds = info[kCGWindowBounds as String] as? NSDictionary,
            let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary)
        else {
            return nil
        }

        return WindowCandidate(
            windowID: windowID,
            ownerPID: ownerPID,
            layer: layer,
            bounds: rect,
            ownerName: info[kCGWindowOwnerName as String] as? String ?? ""
        )
    }

    private static func isEligible(_ candidate: WindowCandidate, displayRects: [CGRect]) -> Bool {
        let bounds = candidate.bounds
        guard bounds.width > 0, bounds.height > 0 else {
            return false
        }

        let windowArea = bounds.width * bounds.height
        guard windowArea > 0 else {
            return false
        }

        let visibleRects = displayRects.compactMap { displayRect -> CGRect? in
            let intersection = bounds.intersection(displayRect)
            guard intersection.width > 0, intersection.height > 0 else {
                return nil
            }
            return intersection
        }

        return unionArea(of: visibleRects) / windowArea >= minimumVisibleFraction
    }

    private static func isCovered(
        _ candidate: WindowCandidate,
        by priorCandidates: ArraySlice<WindowCandidate>
    ) -> Bool {
        priorCandidates.contains { prior in
            guard !prior.isWindowServer else { return false }
            let overlap = prior.bounds.intersection(candidate.bounds)
            return overlap.width > 4 && overlap.height > 4
        }
    }

    /// Computes rectangle union area with a vertical sweep. This avoids
    /// double-counting overlapping displays and also handles negative screen
    /// coordinates without assuming a primary-display origin.
    private static func unionArea(of rects: [CGRect]) -> CGFloat {
        let validRects = rects.filter { $0.width > 0 && $0.height > 0 }
        let xCoordinates = Set(validRects.flatMap { [$0.minX, $0.maxX] }).sorted()
        guard xCoordinates.count > 1 else {
            return 0
        }

        var area: CGFloat = 0
        for pair in zip(xCoordinates, xCoordinates.dropFirst()) {
            let xStart = pair.0
            let xEnd = pair.1
            let width = xEnd - xStart
            guard width > 0 else { continue }

            let yIntervals = validRects.compactMap { rect -> (CGFloat, CGFloat)? in
                guard rect.minX < xEnd, rect.maxX > xStart else { return nil }
                return (rect.minY, rect.maxY)
            }.sorted { $0.0 < $1.0 }

            var coveredHeight: CGFloat = 0
            var currentInterval: (CGFloat, CGFloat)?
            for interval in yIntervals {
                guard let current = currentInterval else {
                    currentInterval = interval
                    continue
                }

                if interval.0 <= current.1 {
                    currentInterval = (current.0, max(current.1, interval.1))
                } else {
                    coveredHeight += current.1 - current.0
                    currentInterval = interval
                }
            }
            if let current = currentInterval {
                coveredHeight += current.1 - current.0
            }

            area += width * coveredHeight
        }
        return area
    }
}
