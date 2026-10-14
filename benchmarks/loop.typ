// Tight numeric loop — arithmetic, comparison and variable assignment with no
// calls at all, so it isolates instruction dispatch from call overhead.
let total = 0
let i = 0

while i < 200000 {
    total += i % 7
    i += 1
}

print("loop total =", total)
