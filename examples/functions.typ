// functions.typ — first-class functions and lexical closures.
fn makeCounter(start) {
    let count = start
    fn increment(step) {
        count += step
        return count
    }
    return increment
}

const counter = makeCounter(10)
print(counter(1))  // 11
print(counter(2))  // 13
print(counter(5))  // 18

// Each call to the factory captures its own independent state.
const other = makeCounter(100)
print(counter(1))  // 19
print(other(1))  // 101

// Functions are values: pass them around, store them in collections.
fn applyTwice(f, value) {
    return f(f(value))
}

fn double(n) {
    return n * 2
}

print("applyTwice(double, 3) =", applyTwice(double, 3))

const operations = { "triple": fn (n) { return n * 3 } }
print("triple(4) =", operations.triple(4))

// Mutual recursion through hoisted declarations.
fn isEven(n) {
    if n == 0 {
        return true
    }
    return isOdd(n - 1)
}

fn isOdd(n) {
    if n == 0 {
        return false
    }
    return isEven(n - 1)
}

print("isEven(10):", isEven(10), " isOdd(7):", isOdd(7))
