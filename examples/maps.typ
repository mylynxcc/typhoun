// maps.typ — key/value collections with scalar keys.
let user = { "name": "Jay", "language": "Typhoun", "level": 7, "active": true }

print("user:", user)
print("name:", user.name)
print("language:", user.language)  // dot sugar for user["language"]

// Insert and update.
user.level += 1
user.city = "Lagos"
print("updated level:", user.level)
print("size:", len(user))

// Missing keys read as null rather than failing.
print("missing key:", user.nickname)
print("has 'city':", has(user, "city"))

// Iterate the keys, then the values.
for key in user {
    print("  key:", key)
}
print("values:", values(user))

// Remove an entry.
remove(user, "active")
print("after remove:", keys(user))
