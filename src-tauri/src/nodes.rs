use serde_json::Value;
use std::{fs, path::{Component, Path, PathBuf}};
fn safe_relative(value: &str) -> Result<PathBuf,String> {
 let p=Path::new(value);
 if value.trim().is_empty() || p.is_absolute() || p.components().any(|c| !matches!(c,Component::Normal(_))) { return Err("Invalid node library path.".into()); }
 Ok(p.to_path_buf())
}
fn ensure_library(root: &Path) -> Result<(),String> {
 fs::create_dir_all(root.join("Default")).map_err(|e|format!("Could not create node library: {e}"))?; Ok(())
}
#[tauri::command]
pub fn list_node_definitions(library_folder: String) -> Result<Vec<Value>,String> {
 if library_folder.trim().is_empty(){return Ok(Vec::new())}
 let root=PathBuf::from(library_folder); ensure_library(&root)?;
 let mut out=Vec::new();
 for cat in fs::read_dir(&root).map_err(|e|format!("Could not read node library: {e}"))? {
  let cat=cat.map_err(|e|e.to_string())?; if !cat.path().is_dir(){continue}
  let category=cat.file_name().to_string_lossy().to_string();
  for entry in fs::read_dir(cat.path()).map_err(|e|e.to_string())? {
   let path=entry.map_err(|e|e.to_string())?.path();
   if path.extension().and_then(|x|x.to_str())!=Some("nod"){continue}
   let mut value:Value=serde_json::from_str(&fs::read_to_string(&path).map_err(|e|e.to_string())?).map_err(|e|format!("Invalid .nod definition: {e}"))?;
   if let Some(obj)=value.as_object_mut(){obj.entry("category").or_insert(Value::String(category.clone()));}
   out.push(value);
  }
 }
 out.sort_by(|a,b|a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))); Ok(out)
}
#[tauri::command]
pub fn create_node_category(library_folder:String, category:String)->Result<(),String>{
 let root=PathBuf::from(library_folder); ensure_library(&root)?; let name=category.trim();
 if name.is_empty() || name=="." || name==".." || name.contains(['\\','/']) {return Err("Enter a valid category name.".into())}
 fs::create_dir(root.join(name)).map_err(|e|format!("Could not create category: {e}"))?; Ok(())
}
#[tauri::command]
pub fn list_node_categories(library_folder:String)->Result<Vec<String>,String>{
 if library_folder.trim().is_empty(){return Ok(vec!["Default".into()])}
 let root=PathBuf::from(library_folder); ensure_library(&root)?; let mut items=Vec::new();
 for e in fs::read_dir(root).map_err(|e|e.to_string())? {let e=e.map_err(|e|e.to_string())?; if e.path().is_dir(){items.push(e.file_name().to_string_lossy().to_string())}}
 items.sort(); Ok(items)
}
#[tauri::command]
pub fn save_node_definition(library_folder:String, definition:Value, category:String)->Result<(),String>{
 let root=PathBuf::from(library_folder); ensure_library(&root)?; let rel=safe_relative(category.trim())?;
 if rel.components().count()!=1 {return Err("Invalid category.".into())} let folder=root.join(rel);
 if !folder.is_dir(){return Err("Node category does not exist.".into())}
 let name=definition["name"].as_str().ok_or("Node definition needs a name.")?;
 let safe:String=name.chars().map(|c|if c.is_ascii_alphanumeric()||c=='_'||c=='-' {c}else{'_'}).collect();
 let filename=if safe.is_empty(){"node".to_string()}else{safe};
 let path=folder.join(format!("{filename}.nod"));
 if path.exists() {
  let existing:Value=serde_json::from_str(&fs::read_to_string(&path).map_err(|e|format!("Could not read existing node definition: {e}"))?).map_err(|e|format!("Existing .nod definition is invalid: {e}"))?;
  if existing["id"] != definition["id"] { return Err("A node with that name already exists in this category. Choose a different name.".into()) }
 }
 let contents=serde_json::to_string_pretty(&definition).map_err(|e|e.to_string())?;
 fs::write(path,contents).map_err(|e|format!("Could not save node definition: {e}"))
}

#[tauri::command]
pub fn move_node_definition(library_folder:String, definition_id:String, from_category:String, to_category:String)->Result<(),String>{
 let root=PathBuf::from(library_folder); ensure_library(&root)?;
 let from=root.join(safe_relative(from_category.trim())?); let to=root.join(safe_relative(to_category.trim())?);
 if !from.is_dir() || !to.is_dir() {return Err("Choose existing source and destination categories.".into())}
 for entry in fs::read_dir(&from).map_err(|e|e.to_string())? {
  let path=entry.map_err(|e|e.to_string())?.path(); if path.extension().and_then(|x|x.to_str())!=Some("nod"){continue}
  let mut value:Value=serde_json::from_str(&fs::read_to_string(&path).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
  if value["id"].as_str()!=Some(definition_id.as_str()){continue}
  value["category"]=Value::String(to_category.clone()); let contents=serde_json::to_string_pretty(&value).map_err(|e|e.to_string())?;
  let dest=to.join(path.file_name().ok_or("Invalid node filename.")?); if dest.exists(){return Err("A node with that filename already exists in the destination category.".into())}
  fs::write(&dest,contents).map_err(|e|format!("Could not write node definition: {e}"))?;
  fs::remove_file(path).map_err(|e|format!("Could not remove old node definition: {e}"))?; return Ok(())
 }
 Err("Could not find that node definition in its current category.".into())
}
