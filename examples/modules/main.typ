// main.typ — module imports, executed with:
//   typhoun run examples/modules/main.typ

// A bare import merges the module's exported names into this scope.
import "math.typ"

print("add(10, 20) =", add(10, 20))
print("subtract(20, 5) =", subtract(20, 5))
print("circleArea(2) =", circleArea(2))

// `import ... as name` binds the namespace instead of merging names.
import "math.typ" as math

print("via namespace:", math.multiply(6, 7), "and PI =", math.PI)
