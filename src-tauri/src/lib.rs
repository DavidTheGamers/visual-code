mod nodes;

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde_json::Value;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectEntry {
    path: String,
    name: String,
    is_dir: bool,
    extension: Option<String>,
}

fn project_root(project_folder: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(project_folder)
        .map_err(|e| format!("Cannot access project folder: {e}"))?;

    if !root.is_dir() {
        return Err("The selected project path is not a directory.".into());
    }

    Ok(root)
}

fn safe_relative_path(relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);

    if relative.trim().is_empty()
        || path.is_absolute()
        || path.components().any(|part| {
            !matches!(part, Component::Normal(_))
        })
    {
        return Err("Invalid project-relative path.".into());
    }

    Ok(path.to_path_buf())
}

fn relative_string(path: &Path) -> Result<String, String> {
    path.components()
        .map(|part| match part {
            Component::Normal(value) => value
                .to_str()
                .map(str::to_owned)
                .ok_or_else(|| "File name is not valid Unicode.".to_string()),
            _ => Err("Invalid project path.".to_string()),
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|parts| parts.join("/"))
}

fn collect_entries(
    root: &Path,
    directory: &Path,
    result: &mut Vec<ProjectEntry>,
) -> Result<(), String> {
    let entries = fs::read_dir(directory)
        .map_err(|e| format!("Cannot list project files: {e}"))?;

    for item in entries {
        let item = item.map_err(|e| e.to_string())?;
        let file_type = item.file_type().map_err(|e| e.to_string())?;

        // Do not follow symbolic links.
        if file_type.is_symlink() {
            continue;
        }

        let path = item.path();
        let is_dir = file_type.is_dir();

        let relative = path
            .strip_prefix(root)
            .map_err(|e| e.to_string())?;

        let relative = relative_string(relative)?;

        if relative == EXPLORER_ORDER_FILE {
            continue;
        }

        let name = item
            .file_name()
            .to_str()
            .ok_or_else(|| "File name is not valid Unicode.".to_string())?
            .to_owned();

        let extension = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(str::to_owned);

        result.push(ProjectEntry {
            path: relative,
            name,
            is_dir,
            extension,
        });

        if is_dir {
            collect_entries(root, &path, result)?;
        }
    }

    Ok(())
}

#[tauri::command]
fn list_project_entries(
    project_folder: String,
) -> Result<Vec<ProjectEntry>, String> {
    let root = project_root(&project_folder)?;
    let mut entries = Vec::new();

    collect_entries(&root, &root, &mut entries)?;

    entries.sort_by(|a, b| {
        a.path.to_lowercase().cmp(&b.path.to_lowercase())
    });

    Ok(entries)
}

#[tauri::command]
fn list_project_graphs(
    project_folder: String,
) -> Result<Vec<String>, String> {
    let entries = list_project_entries(project_folder)?;

    Ok(entries
        .into_iter()
        .filter(|entry| {
            !entry.is_dir
                && entry.extension.as_deref()
                    .map(|ext| ext.eq_ignore_ascii_case("graph"))
                    .unwrap_or(false)
        })
        .map(|entry| entry.path)
        .collect())
}

fn existing_project_file(
    root: &Path,
    relative: &str,
) -> Result<PathBuf, String> {
    let relative_path = safe_relative_path(relative)?;
    let path = root.join(relative_path);

    let actual = fs::canonicalize(&path)
        .map_err(|e| format!("Cannot access project file: {e}"))?;

    if !actual.starts_with(root) || !actual.is_file() {
        return Err("The path is not a file inside this project.".into());
    }

    Ok(actual)
}

fn existing_project_entry(
    root: &Path,
    relative: &str,
) -> Result<PathBuf, String> {
    let relative_path = safe_relative_path(relative)?;
    let path = root.join(relative_path);

    let actual = fs::canonicalize(&path)
        .map_err(|e| format!("Cannot access project entry: {e}"))?;

    if !actual.starts_with(root) {
        return Err("The entry must remain inside this project.".into());
    }

    if actual == *root {
        return Err("The project root cannot be moved or deleted.".into());
    }

    Ok(actual)
}

fn validate_destination_parent(
    root: &Path,
    path: &Path,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid destination location.".to_string())?;

    let canonical_parent = fs::canonicalize(parent)
        .map_err(|e| format!("Cannot access destination folder: {e}"))?;

    if !canonical_parent.starts_with(root) || !canonical_parent.is_dir() {
        return Err("The destination must be inside the project.".into());
    }

    Ok(())
}

#[tauri::command]
fn read_project_file(
    project_folder: String,
    file_path: String,
) -> Result<String, String> {
    let root = project_root(&project_folder)?;
    let path = existing_project_file(&root, &file_path)?;

    fs::read_to_string(path)
        .map_err(|e| format!("Cannot read this file as text: {e}"))
}

#[tauri::command]
fn write_project_file(
    project_folder: String,
    file_path: String,
    contents: String,
) -> Result<(), String> {
    let root = project_root(&project_folder)?;
    let relative = safe_relative_path(&file_path)?;
    let path = root.join(relative);

    if path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("nod"))
        .unwrap_or(false)
    {
        return Err(
            "Save graph files using Visual Code's graph save action.".into()
        );
    }

    validate_destination_parent(&root, &path)?;

    if path.exists() {
        let actual = fs::canonicalize(&path)
            .map_err(|e| format!("Cannot access the file: {e}"))?;

        if !actual.starts_with(&root) || !actual.is_file() {
            return Err("The target is not a valid project file.".into());
        }

        fs::write(actual, contents)
            .map_err(|e| format!("Cannot save file: {e}"))?;
    } else {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| format!("Cannot create file: {e}"))?;

        file.write_all(contents.as_bytes())
            .map_err(|e| format!("Cannot finish saving file: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
fn create_project_file(
    project_folder: String,
    file_path: String,
    contents: String,
) -> Result<(), String> {
    let root = project_root(&project_folder)?;
    let relative = safe_relative_path(&file_path)?;
    let path = root.join(relative);

    if path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("nod"))
        .unwrap_or(false)
    {
        return Err(
            "Create graph files using Visual Code's graph creation action.".into()
        );
    }

    validate_destination_parent(&root, &path)?;

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("Cannot create file: {e}"))?;

    file.write_all(contents.as_bytes())
        .map_err(|e| format!("Cannot finish creating file: {e}"))?;

    Ok(())
}

// Creates one new folder inside the project or one of its subfolders.
#[tauri::command]
fn create_project_directory(
    project_folder: String,
    directory_path: String,
) -> Result<(), String> {
    let root = project_root(&project_folder)?;
    let relative = safe_relative_path(&directory_path)?;
    let path = root.join(relative);

    validate_destination_parent(&root, &path)?;

    fs::create_dir(&path)
        .map_err(|e| format!("Cannot create folder: {e}"))?;

    Ok(())
}

#[tauri::command]
fn read_project_graph(
    project_folder: String,
    file_name: String,
) -> Result<String, String> {
    if !Path::new(&file_name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("graph"))
        .unwrap_or(false)
    {
        return Err("Graph files must use the .graph extension.".into());
    }

    let root = project_root(&project_folder)?;
    let path = existing_project_file(&root, &file_name)?;

    fs::read_to_string(path)
        .map_err(|e| format!("Cannot read graph: {e}"))
}

#[tauri::command]
fn save_project_graph(
    project_folder: String,
    file_name: String,
    contents: String,
    overwrite: bool,
) -> Result<(), String> {
    let relative = safe_relative_path(&file_name)?;

    if !relative.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("graph"))
        .unwrap_or(false)
    {
        return Err("Graph files must use the .graph extension.".into());
    }

    let root = project_root(&project_folder)?;
    let path = root.join(relative);

    validate_destination_parent(&root, &path)?;

    if path.exists() && !overwrite {
        return Err(
            "A graph with that name already exists. Choose another name or explicitly replace it."
                .into(),
        );
    }

    if path.exists() {
        let actual = fs::canonicalize(&path)
            .map_err(|e| format!("Cannot access graph: {e}"))?;

        if !actual.starts_with(&root) || !actual.is_file() {
            return Err("The graph must be a file inside the project.".into());
        }

        fs::write(actual, contents)
            .map_err(|e| format!("Cannot save graph: {e}"))?;
    } else {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| format!("Cannot create graph: {e}"))?;

        file.write_all(contents.as_bytes())
            .map_err(|e| format!("Cannot finish saving graph: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
fn delete_project_graph(
    project_folder: String,
    file_path: String,
) -> Result<(), String> {
    let relative = safe_relative_path(&file_path)?;

    if !relative.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("graph"))
        .unwrap_or(false)
    {
        return Err(
            "Only .graph graph files can be deleted with this action.".into()
        );
    }

    let root = project_root(&project_folder)?;
    let path = existing_project_file(&root, &file_path)?;

    fs::remove_file(path)
        .map_err(|e| format!("Cannot delete graph: {e}"))?;

    Ok(())
}

// Collects the files that will be affected by moving an entry.
fn collect_file_paths(
    root: &Path,
    entry: &Path,
    result: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if entry.is_file() {
        result.push(entry.to_path_buf());
        return Ok(());
    }

    if entry.is_dir() {
        for item in fs::read_dir(entry)
            .map_err(|e| format!("Cannot inspect folder: {e}"))?
        {
            let item = item.map_err(|e| e.to_string())?;
            let file_type = item.file_type().map_err(|e| e.to_string())?;

            if file_type.is_symlink() {
                continue;
            }

            let path = item.path();

            if file_type.is_file() {
                result.push(path);
            } else if file_type.is_dir() {
                collect_file_paths(root, &path, result)?;
            }
        }

        return Ok(());
    }

    let _ = root;
    Err("Unsupported project entry type.".into())
}

// Updates sourceFile references in .graph files after a move.
fn update_graph_source_references(
    root: &Path,
    moved_paths: &HashMap<String, String>,
) -> Result<(), String> {
    if moved_paths.is_empty() {
        return Ok(());
    }

    let mut entries = Vec::new();
    collect_entries(root, root, &mut entries)?;

    for entry in entries {
        if entry.is_dir
            || !entry.extension.as_deref()
                .map(|ext| ext.eq_ignore_ascii_case("graph"))
                .unwrap_or(false)
        {
            continue;
        }

        let graph_path = root.join(safe_relative_path(&entry.path)?);
        let contents = match fs::read_to_string(&graph_path) {
            Ok(contents) => contents,
            Err(_) => continue,
        };

        let mut json: Value = match serde_json::from_str(&contents) {
            Ok(value) => value,
            Err(_) => continue,
        };

        let mut changed = false;

        if let Some(source_file) = json.get_mut("sourceFile") {
            if let Some(source) = source_file.as_str() {
                let normalized = source.replace('\\', "/");

                if let Some(new_path) = moved_paths.get(&normalized) {
                    *source_file = Value::String(new_path.clone());
                    changed = true;
                }
            }
        }

        if changed {
            let updated = serde_json::to_string_pretty(&json)
                .map_err(|e| format!("Cannot update graph references: {e}"))?;

            fs::write(&graph_path, updated)
                .map_err(|e| format!("Cannot save updated graph: {e}"))?;
        }
    }

    Ok(())
}

// Moves a file, graph, or folder to another location within the project.
// destination_path is the full new relative path, including the entry's name.
#[tauri::command]
fn move_project_entry(
    project_folder: String,
    source_path: String,
    destination_path: String,
) -> Result<(), String> {
    let root = project_root(&project_folder)?;

    let source = existing_project_entry(&root, &source_path)?;
    let destination_relative = safe_relative_path(&destination_path)?;
    let destination = root.join(&destination_relative);

    if destination.exists() {
        return Err("An entry with that name already exists at the destination.".into());
    }

    validate_destination_parent(&root, &destination)?;

    if source.is_dir() && destination.starts_with(&source) {
        return Err("A folder cannot be moved into itself or its own subfolder.".into());
    }

    let mut files_before = Vec::new();
    collect_file_paths(&root, &source, &mut files_before)?;

    let mut updated_paths = HashMap::new();

    for old_file in files_before {
        let old_relative = old_file
            .strip_prefix(&root)
            .map_err(|e| e.to_string())?;

        let suffix = old_file
            .strip_prefix(&source)
            .map_err(|e| e.to_string())?;

        let new_file = if source.is_dir() {
            destination.join(suffix)
        } else {
            destination.clone()
        };

        let old_relative = relative_string(old_relative)?;
        let new_relative = relative_string(
            new_file.strip_prefix(&root).map_err(|e| e.to_string())?
        )?;

        updated_paths.insert(old_relative, new_relative);
    }

    fs::rename(&source, &destination)
        .map_err(|e| format!("Cannot move project entry: {e}"))?;

    update_graph_source_references(&root, &updated_paths)?;

    Ok(())
}

// Explorer ordering is stored as JSON text in a project metadata file.
// The frontend should pass a JSON array of relative paths.
const EXPLORER_ORDER_FILE: &str = ".visual-code-explorer-order.json";

#[tauri::command]
fn read_explorer_order(
    project_folder: String,
) -> Result<String, String> {
    let root = project_root(&project_folder)?;
    let path = root.join(EXPLORER_ORDER_FILE);

    if !path.exists() {
        return Ok("[]".to_string());
    }

    let actual = fs::canonicalize(&path)
        .map_err(|e| format!("Cannot access Explorer order: {e}"))?;

    if !actual.starts_with(&root) || !actual.is_file() {
        return Err("Invalid Explorer order file.".into());
    }

    fs::read_to_string(actual)
        .map_err(|e| format!("Cannot read Explorer order: {e}"))
}

#[tauri::command]
fn save_explorer_order(
    project_folder: String,
    order_json: String,
) -> Result<(), String> {
    let root = project_root(&project_folder)?;

    // Reject malformed JSON before saving it.
    let parsed: Value = serde_json::from_str(&order_json)
        .map_err(|e| format!("Invalid Explorer order data: {e}"))?;

    if !parsed.is_array() {
        return Err("Explorer order must be a JSON array.".into());
    }

    let path = root.join(EXPLORER_ORDER_FILE);

    fs::write(path, order_json)
        .map_err(|e| format!("Cannot save Explorer order: {e}"))?;

    Ok(())
}

#[tauri::command]
fn delete_project_entry(
    project_folder: String,
    file_path: String,
) -> Result<(), String> {
    let root = project_root(&project_folder)?;
    let path = existing_project_entry(&root, &file_path)?;

    if path.is_dir() {
        fs::remove_dir_all(&path)
            .map_err(|e| format!("Cannot delete folder and its contents: {e}"))?;
    } else if path.is_file() {
        fs::remove_file(&path)
            .map_err(|e| format!("Cannot delete file: {e}"))?;
    } else {
        return Err("The selected entry is not a regular file or folder.".into());
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_project_entries,
            list_project_graphs,
            read_project_file,
            write_project_file,
            create_project_file,
            create_project_directory,
            read_project_graph,
            save_project_graph,
            delete_project_graph,
            move_project_entry,
            read_explorer_order,
            save_explorer_order,
            delete_project_entry,
            nodes::list_node_definitions,
            nodes::list_node_categories,
            nodes::save_node_definition,
            nodes::create_node_category,
            nodes::move_node_definition,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
