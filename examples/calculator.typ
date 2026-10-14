// calculator.typ — arithmetic over two operands.
const a = 12
const b = 5

print("a =", a)
print("b =", b)
print("a + b =", a + b)
print("a - b =", a - b)
print("a * b =", a * b)
print("a / b =", a / b)
print("a % b =", a % b)

// Precedence: * and % bind tighter than + and -.
print("2 + 3 * 4 =", 2 + 3 * 4)
print("(2 + 3) * 4 =", (2 + 3) * 4)

// Functions turn the calculation into a reusable tool.
fn describe(label, value) {
    return label + " -> " + str(value)
}

print(describe("sum", a + b))
print(describe("average", (a + b) / 2))
