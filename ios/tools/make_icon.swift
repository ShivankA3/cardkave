// Renders the CardKave app icon (1024×1024 PNG) with CoreGraphics/AppKit.
// Usage: swift make_icon.swift <output.png>
import AppKit

let size = 1024.0
let outPath = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "AppIcon.png"

let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()

let full = NSRect(x: 0, y: 0, width: size, height: size)

// Dark background, matching the web app's default surface, with a subtle
// vertical gradient for depth.
let gradient = NSGradient(
    starting: NSColor(red: 0.078, green: 0.078, blue: 0.094, alpha: 1),
    ending:   NSColor(red: 0.043, green: 0.043, blue: 0.055, alpha: 1)
)
gradient?.draw(in: full, angle: 90)

// White ring with a dark centre — echoes the favicon mark.
let outer = size * 0.40
let outerRect = NSRect(x: (size - outer) / 2, y: (size - outer) / 2, width: outer, height: outer)
NSColor.white.setFill()
NSBezierPath(ovalIn: outerRect).fill()

let inner = outer * 0.42
let innerRect = NSRect(x: (size - inner) / 2, y: (size - inner) / 2, width: inner, height: inner)
NSColor(red: 0.078, green: 0.078, blue: 0.094, alpha: 1).setFill()
NSBezierPath(ovalIn: innerRect).fill()

image.unlockFocus()

guard let tiff = image.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write(Data("Failed to render icon\n".utf8))
    exit(1)
}

do {
    try png.write(to: URL(fileURLWithPath: outPath))
    print("Wrote \(outPath)")
} catch {
    FileHandle.standardError.write(Data("Write failed: \(error)\n".utf8))
    exit(1)
}
