import Cocoa

struct KreeIcons {
    static func statusIcon(active: Bool) -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
            NSColor.black.setStroke()
            NSColor.black.setFill()
            
            // 1. Outer Oval (The Gold Plate border)
            // A flattened oval occupying most of the width
            let ovalRect = NSRect(x: 1.5, y: 4, width: 15, height: 10)
            let oval = NSBezierPath(ovalIn: ovalRect)
            oval.lineWidth = active ? 1.5 : 1.0
            oval.stroke()
            
            // 2. The Serpent/Coil Symbol (Inside)
            let serpent = NSBezierPath()
            serpent.lineWidth = active ? 1.5 : 1.0
            serpent.lineCapStyle = .round
            serpent.lineJoinStyle = .round
            
            // Bottom bar connecting the coils
            serpent.move(to: NSPoint(x: 6.5, y: 6.5))
            serpent.line(to: NSPoint(x: 11.5, y: 6.5))
            
            // Left Coil: Up, Out, then Curl In
            serpent.move(to: NSPoint(x: 6.5, y: 6.5))
            // Curve out to left
            serpent.curve(to: NSPoint(x: 4.5, y: 9.5), 
                          controlPoint1: NSPoint(x: 4.0, y: 6.5), 
                          controlPoint2: NSPoint(x: 3.5, y: 9.0))
            // Curl in to right
            serpent.curve(to: NSPoint(x: 7.0, y: 9.0), 
                          controlPoint1: NSPoint(x: 5.0, y: 10.5), 
                          controlPoint2: NSPoint(x: 6.5, y: 10.0))
            
            // Right Coil: Mirror image
            serpent.move(to: NSPoint(x: 11.5, y: 6.5))
            // Curve out to right
            serpent.curve(to: NSPoint(x: 13.5, y: 9.5), 
                          controlPoint1: NSPoint(x: 14.0, y: 6.5), 
                          controlPoint2: NSPoint(x: 14.5, y: 9.0))
            // Curl in to left
            serpent.curve(to: NSPoint(x: 11.0, y: 9.0), 
                          controlPoint1: NSPoint(x: 13.0, y: 10.5), 
                          controlPoint2: NSPoint(x: 11.5, y: 10.0))
            
            serpent.stroke()
            
            // 3. Central Dot/Gem (The "eye" of the serpent, often distinct)
            // Just a small dot in the middle-top to balance it?
            // Actually the original symbol has a small curve in the middle.
            // Let's keep it simple with the coils.
            
            return true
        }
        image.isTemplate = true
        return image
    }
    
    static func warningIcon() -> NSImage {
        if let img = NSImage(systemSymbolName: "exclamationmark.triangle", accessibilityDescription: "Warning") {
            return img
        }
        return NSImage() // Should not happen
    }
}
