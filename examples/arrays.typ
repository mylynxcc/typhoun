// arrays.typ — ordered, mutable collections with zero-based indexing.
let fruits = ["apple", "mango", "orange"]

print("fruits:", fruits)
print("length:", len(fruits))
print("first:", fruits[0])
print("last:", fruits[len(fruits) - 1])

// Arrays are mutable: assign to a slot, push a new element, pop one off.
fruits[1] = "banana"
push(fruits, "kiwi")
print("after edits:", fruits)

const popped = pop(fruits)
print("popped:", popped, "-> now", fruits)

// Iterate, and accumulate.
let total = 0
for n in [1, 2, 3, 4, 5] {
    total += n
}
print("sum of 1..5 =", total)

// Nested arrays.
const grid = [[1, 2], [3, 4], [5, 6]]
print("grid[2][1] =", grid[2][1])

// Membership and text helpers.
print("contains mango:", contains(fruits, "mango"))
print("joined:", join(fruits, ", "))
print("has index 0:", has(fruits, 0))
