// math.typ — a small module. Every top-level declaration is exported.
const PI = 3.14159

fn add(a, b) {
    return a + b
}

fn subtract(a, b) {
    return a - b
}

fn multiply(a, b) {
    return a * b
}

fn circleArea(radius) {
    return PI * radius * radius
}
