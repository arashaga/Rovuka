use anyhow::bail;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum GraphicsMode {
    Software,
    Gpu,
}

pub fn resolve(value: &str) -> anyhow::Result<GraphicsMode> {
    match value {
        "" | "auto" => Ok(if cfg!(target_os = "windows") {
            GraphicsMode::Software
        } else {
            GraphicsMode::Gpu
        }),
        "software" => Ok(GraphicsMode::Software),
        "gpu" => Ok(GraphicsMode::Gpu),
        _ => bail!("Invalid --graphics value. Use auto, software, or gpu."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn graphics_modes_are_explicit_and_invalid_values_fail() {
        assert_eq!(resolve("software").unwrap(), GraphicsMode::Software);
        assert_eq!(resolve("gpu").unwrap(), GraphicsMode::Gpu);
        assert!(resolve("invalid").is_err());
        assert_eq!(
            resolve("auto").unwrap(),
            if cfg!(target_os = "windows") {
                GraphicsMode::Software
            } else {
                GraphicsMode::Gpu
            }
        );
    }
}
