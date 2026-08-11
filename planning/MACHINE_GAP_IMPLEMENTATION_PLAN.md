# Machine-Core Gap Implementation Plan

This document provides implementation plans for gaps identified during the code review of machine-core against the replybot JavaScript reference.

---

## Scope Summary

After review, the implementation scope has been narrowed to focus on valuable cross-platform functionality:

| Priority | Gap                                     | Module        | Effort |
|----------|-----------------------------------------|---------------|--------|
| **HIGH** | Expand unicode numeral support          | validate.rs   | Medium |
| **HIGH** | Wire unicode into navigation conditions | navigation.rs | Medium |

### Deliberately Not Implementing

The following features from replybot are being **intentionally dropped** in the Rust migration:

| Feature                 | Reason                           |
|-------------------------|----------------------------------|
| OPTIN event handler     | Not needed                       |
| WATERMARK event handler | Not needed                       |
| Notify field type       | Not needed                       |
| Postback support        | Not supporting postbacks in Rust |

### Future Architectural Work

> **TODO:** Handover handling is currently Messenger-specific but needs to remain functional. The current implementation works but violates the principle that exec.rs should be platform-agnostic. Future work needed to either:
> - Move handover normalization upstream to platform-specific event normalizers
> - Create a generic "thread control" abstraction that works across platforms
> - Accept that handover is Messenger-only and document that constraint

---

## Gap 1: Expanded Unicode Numeral Support

### Background

The replybot supports 30+ numeral systems via a comprehensive mapping. The Rust implementation only supports 6 systems. This is important for international surveys where users may input numbers in their native script.

### Current State: validate.rs

```rust
fn normalize_unicode_numerals(s: &str) -> String {
    s.chars().map(|c| {
        match c {
            '\u{0660}'..='\u{0669}' => // Arabic-Indic
            '\u{06F0}'..='\u{06F9}' => // Extended Arabic-Indic
            '\u{0966}'..='\u{096F}' => // Devanagari
            '\u{09E6}'..='\u{09EF}' => // Bengali
            '\u{0E50}'..='\u{0E59}' => // Thai
            '\u{06F0}'..='\u{06F9}' => // Persian (duplicate of Extended Arabic)
            _ => c,
        }
    }).collect()
}
```

**Issues:**
- Only 6 numeral systems (5 unique - Persian duplicates Extended Arabic-Indic)
- Missing major systems: Gujarati, Kannada, Malayalam, Telugu, Oriya, Tibetan, Myanmar, Khmer, etc.

### Implementation

**File:** `machine/machine-core/src/validate.rs`

Replace the limited implementation with comprehensive support:

```rust
/// Normalizes unicode numerals from various writing systems to ASCII digits.
/// Supports 20+ numeral systems used globally.
pub fn normalize_unicode_numerals(s: &str) -> String {
    s.chars().map(|c| {
        match c {
            // Arabic-Indic (٠-٩)
            '\u{0660}'..='\u{0669}' => char::from_digit((c as u32) - 0x0660, 10).unwrap(),
            // Extended Arabic-Indic / Persian (۰-۹)
            '\u{06F0}'..='\u{06F9}' => char::from_digit((c as u32) - 0x06F0, 10).unwrap(),
            // Devanagari (०-९)
            '\u{0966}'..='\u{096F}' => char::from_digit((c as u32) - 0x0966, 10).unwrap(),
            // Bengali (০-৯)
            '\u{09E6}'..='\u{09EF}' => char::from_digit((c as u32) - 0x09E6, 10).unwrap(),
            // Gurmukhi (੦-੯)
            '\u{0A66}'..='\u{0A6F}' => char::from_digit((c as u32) - 0x0A66, 10).unwrap(),
            // Gujarati (૦-૯)
            '\u{0AE6}'..='\u{0AEF}' => char::from_digit((c as u32) - 0x0AE6, 10).unwrap(),
            // Oriya (୦-୯)
            '\u{0B66}'..='\u{0B6F}' => char::from_digit((c as u32) - 0x0B66, 10).unwrap(),
            // Tamil (௦-௯)
            '\u{0BE6}'..='\u{0BEF}' => char::from_digit((c as u32) - 0x0BE6, 10).unwrap(),
            // Telugu (౦-౯)
            '\u{0C66}'..='\u{0C6F}' => char::from_digit((c as u32) - 0x0C66, 10).unwrap(),
            // Kannada (೦-೯)
            '\u{0CE6}'..='\u{0CEF}' => char::from_digit((c as u32) - 0x0CE6, 10).unwrap(),
            // Malayalam (൦-൯)
            '\u{0D66}'..='\u{0D6F}' => char::from_digit((c as u32) - 0x0D66, 10).unwrap(),
            // Sinhala (෦-෯)
            '\u{0DE6}'..='\u{0DEF}' => char::from_digit((c as u32) - 0x0DE6, 10).unwrap(),
            // Thai (๐-๙)
            '\u{0E50}'..='\u{0E59}' => char::from_digit((c as u32) - 0x0E50, 10).unwrap(),
            // Lao (໐-໙)
            '\u{0ED0}'..='\u{0ED9}' => char::from_digit((c as u32) - 0x0ED0, 10).unwrap(),
            // Tibetan (༠-༩)
            '\u{0F20}'..='\u{0F29}' => char::from_digit((c as u32) - 0x0F20, 10).unwrap(),
            // Myanmar (၀-၉)
            '\u{1040}'..='\u{1049}' => char::from_digit((c as u32) - 0x1040, 10).unwrap(),
            // Myanmar Shan (႐-႙)
            '\u{1090}'..='\u{1099}' => char::from_digit((c as u32) - 0x1090, 10).unwrap(),
            // Khmer (០-៩)
            '\u{17E0}'..='\u{17E9}' => char::from_digit((c as u32) - 0x17E0, 10).unwrap(),
            // Mongolian (᠐-᠙)
            '\u{1810}'..='\u{1819}' => char::from_digit((c as u32) - 0x1810, 10).unwrap(),
            // Limbu (᥆-᥏)
            '\u{1946}'..='\u{194F}' => char::from_digit((c as u32) - 0x1946, 10).unwrap(),
            // Fullwidth digits (０-９)
            '\u{FF10}'..='\u{FF19}' => char::from_digit((c as u32) - 0xFF10, 10).unwrap(),
            // Everything else passes through
            _ => c,
        }
    }).collect()
}
```

### Tests to Add

```rust
#[cfg(test)]
mod unicode_numeral_tests {
    use super::*;

    #[test]
    fn test_arabic_indic_numerals() {
        assert_eq!(normalize_unicode_numerals("٠١٢٣٤٥٦٧٨٩"), "0123456789");
    }

    #[test]
    fn test_devanagari_numerals() {
        assert_eq!(normalize_unicode_numerals("०१२३४५६७८९"), "0123456789");
    }

    #[test]
    fn test_bengali_numerals() {
        assert_eq!(normalize_unicode_numerals("০১২৩৪৫৬৭৮৯"), "0123456789");
    }

    #[test]
    fn test_gujarati_numerals() {
        assert_eq!(normalize_unicode_numerals("૦૧૨૩૪૫૬૭૮૯"), "0123456789");
    }

    #[test]
    fn test_gurmukhi_numerals() {
        assert_eq!(normalize_unicode_numerals("੦੧੨੩੪੫੬੭੮੯"), "0123456789");
    }

    #[test]
    fn test_kannada_numerals() {
        assert_eq!(normalize_unicode_numerals("೦೧೨೩೪೫೬೭೮೯"), "0123456789");
    }

    #[test]
    fn test_malayalam_numerals() {
        assert_eq!(normalize_unicode_numerals("൦൧൨൩൪൫൬൭൮൯"), "0123456789");
    }

    #[test]
    fn test_oriya_numerals() {
        assert_eq!(normalize_unicode_numerals("୦୧୨୩୪୫୬୭୮୯"), "0123456789");
    }

    #[test]
    fn test_tamil_numerals() {
        assert_eq!(normalize_unicode_numerals("௦௧௨௩௪௫௬௭௮௯"), "0123456789");
    }

    #[test]
    fn test_telugu_numerals() {
        assert_eq!(normalize_unicode_numerals("౦౧౨౩౪౫౬౭౮౯"), "0123456789");
    }

    #[test]
    fn test_thai_numerals() {
        assert_eq!(normalize_unicode_numerals("๐๑๒๓๔๕๖๗๘๙"), "0123456789");
    }

    #[test]
    fn test_tibetan_numerals() {
        assert_eq!(normalize_unicode_numerals("༠༡༢༣༤༥༦༧༨༩"), "0123456789");
    }

    #[test]
    fn test_khmer_numerals() {
        assert_eq!(normalize_unicode_numerals("០១២៣៤៥៦៧៨៩"), "0123456789");
    }

    #[test]
    fn test_myanmar_numerals() {
        assert_eq!(normalize_unicode_numerals("၀၁၂၃၄၅၆၇၈၉"), "0123456789");
    }

    #[test]
    fn test_fullwidth_numerals() {
        assert_eq!(normalize_unicode_numerals("０１２３４５６７８９"), "0123456789");
    }

    #[test]
    fn test_mixed_numerals_and_text() {
        assert_eq!(normalize_unicode_numerals("Age: २५ years"), "Age: 25 years");
    }

    #[test]
    fn test_mixed_numeral_systems() {
        // Devanagari 1, ASCII 2, Bengali 3, ASCII 4
        assert_eq!(normalize_unicode_numerals("१2৩4"), "1234");
    }
}
```

---

## Gap 2: Wire Unicode Numerals into Navigation

### Background

The `normalize_unicode_numerals` function exists in validate.rs but is **not used** in navigation.rs when evaluating conditions with numeric comparisons. This means logic jumps based on numeric comparisons will fail for users entering numbers in non-ASCII scripts.

### Current State: navigation.rs

The condition evaluation compares values directly without normalization:

```rust
// Numeric comparisons parse the value directly
"greater_than" => {
    let v: f64 = value.parse().ok()?;  // Fails for "२५" (Devanagari 25)
    let e: f64 = expected.parse().ok()?;
    v > e
}
```

### Implementation

**File:** `machine/machine-core/src/navigation.rs`

1. First, check if `normalize_unicode_numerals` is already public or needs to be exported:

```rust
// In validate.rs - ensure function is public
pub fn normalize_unicode_numerals(s: &str) -> String { ... }
```

2. Import in navigation.rs:

```rust
use crate::validate::normalize_unicode_numerals;
```

3. Update numeric comparison operations to normalize first. Find the condition evaluation logic and wrap numeric parsing:

```rust
fn try_parse_number(s: &str) -> Option<f64> {
    normalize_unicode_numerals(s).parse().ok()
}

// Then in condition evaluation:
"greater_than" => {
    let v = try_parse_number(value)?;
    let e = try_parse_number(expected)?;
    v > e
}

"less_than" => {
    let v = try_parse_number(value)?;
    let e = try_parse_number(expected)?;
    v < e
}

"greater_than_or_equal" => {
    let v = try_parse_number(value)?;
    let e = try_parse_number(expected)?;
    v >= e
}

"less_than_or_equal" => {
    let v = try_parse_number(value)?;
    let e = try_parse_number(expected)?;
    v <= e
}
```

4. For `equal` and `is` operators, try numeric comparison first (with normalization), then fall back to string:

```rust
"equal" | "is" => {
    // Try numeric comparison first (handles unicode numerals)
    if let (Some(v), Some(e)) = (try_parse_number(value), try_parse_number(expected)) {
        (v - e).abs() < f64::EPSILON
    } else {
        // Fall back to string comparison
        value == expected
    }
}
```

### Tests to Add

Add to `navigation_logic_tests.rs`:

```rust
#[test]
fn test_greater_than_with_devanagari_numerals() {
    // User enters "२५" (Devanagari 25), condition checks if > 18
    let condition = Condition {
        op: Some("greater_than".to_string()),
        vars: vec![
            ConditionVar { field_ref: Some("age".into()), value: None },
            ConditionVar { field_ref: None, value: Some(json!(18)) },
        ],
    };

    let responses = HashMap::from([("age".to_string(), json!("२५"))]);
    assert!(evaluate_condition_with_responses(&condition, &responses));
}

#[test]
fn test_equal_with_arabic_indic_numerals() {
    // User enters "٣" (Arabic-Indic 3), condition checks if == 3
    let condition = Condition {
        op: Some("equal".to_string()),
        vars: vec![
            ConditionVar { field_ref: Some("choice".into()), value: None },
            ConditionVar { field_ref: None, value: Some(json!(3)) },
        ],
    };

    let responses = HashMap::from([("choice".to_string(), json!("٣"))]);
    assert!(evaluate_condition_with_responses(&condition, &responses));
}

#[test]
fn test_less_than_with_bengali_numerals() {
    // User enters "১০" (Bengali 10), condition checks if < 18
    let condition = Condition {
        op: Some("less_than".to_string()),
        vars: vec![
            ConditionVar { field_ref: Some("age".into()), value: None },
            ConditionVar { field_ref: None, value: Some(json!(18)) },
        ],
    };

    let responses = HashMap::from([("age".to_string(), json!("১০"))]);
    assert!(evaluate_condition_with_responses(&condition, &responses));
}

#[test]
fn test_equal_string_not_affected_by_normalization() {
    // String comparison should still work normally
    let condition = Condition {
        op: Some("equal".to_string()),
        vars: vec![
            ConditionVar { field_ref: Some("answer".into()), value: None },
            ConditionVar { field_ref: None, value: Some(json!("yes")) },
        ],
    };

    let responses = HashMap::from([("answer".to_string(), json!("yes"))]);
    assert!(evaluate_condition_with_responses(&condition, &responses));
}
```

---

## Implementation Steps

### Step 1: Expand Unicode Support in validate.rs

1. Read current `validate.rs` to find exact location of `normalize_unicode_numerals`
2. Replace with expanded implementation
3. Ensure function is `pub` exported
4. Add unit tests for all numeral systems
5. Run `cargo test` to verify

### Step 2: Wire into navigation.rs

1. Read current `navigation.rs` to find condition evaluation logic
2. Add import for `normalize_unicode_numerals`
3. Create helper `try_parse_number` function
4. Update numeric comparison operators
5. Update `equal`/`is` to try numeric first
6. Add integration tests
7. Run `cargo test` to verify

### Step 3: Verify

1. Run full test suite: `cargo test`
2. Run clippy: `cargo clippy`
3. Test with real forms that use numeric conditions

---

## Verification Checklist

- [ ] `normalize_unicode_numerals` supports 20+ numeral systems
- [ ] All numeral system tests pass
- [ ] `normalize_unicode_numerals` is exported from validate.rs
- [ ] navigation.rs imports and uses the function
- [ ] Numeric comparisons (>, <, >=, <=) work with unicode numerals
- [ ] Equal/is comparisons work with unicode numerals
- [ ] String comparisons still work correctly
- [ ] `cargo test` passes
- [ ] `cargo clippy` has no warnings
