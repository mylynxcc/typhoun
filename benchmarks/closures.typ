// Closure creation, captured-variable reads and per-iteration capture cells.
fn makeAdder(n) {
    return fn (x) {
        return x + n
    }
}

let total = 0
for i in range(0, 60000) {
    const adder = makeAdder(i % 5)
    total = adder(total % 1000)
}

print("closures total =", total)
