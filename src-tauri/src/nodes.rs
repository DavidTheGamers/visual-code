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
const CATEGORY_ORDER_FILE: &str = ".category-order.json";
fn read_category_order(root:&Path)->Vec<String>{
 fs::read_to_string(root.join(CATEGORY_ORDER_FILE)).ok().and_then(|text|serde_json::from_str(&text).ok()).unwrap_or_default()
}
fn write_category_order(root:&Path,order:&[String])->Result<(),String>{
 fs::write(root.join(CATEGORY_ORDER_FILE),serde_json::to_string_pretty(order).map_err(|e|e.to_string())?).map_err(|e|format!("Could not save category order: {e}"))
}
fn collect_category_paths(root:&Path)->Result<Vec<String>,String>{
 fn walk(dir:&Path,root:&Path,out:&mut Vec<String>)->Result<(),String>{
  for entry in fs::read_dir(dir).map_err(|e|e.to_string())? {let path=entry.map_err(|e|e.to_string())?.path();if !path.is_dir(){continue}
   let relative=path.strip_prefix(root).map_err(|e|e.to_string())?.to_string_lossy().replace('\\',"/");out.push(relative);walk(&path,root,out)?;
  } Ok(())
 }
 let mut paths=Vec::new();walk(root,root,&mut paths)?;Ok(paths)
}
fn complete_category_order(root:&Path)->Result<Vec<String>,String>{
 let mut paths=collect_category_paths(root)?;paths.sort();
 if let Some(index)=paths.iter().position(|path|path=="Default"){let default=paths.remove(index);paths.insert(0,default)}
 let mut order=read_category_order(root);
 if order.is_empty(){return Ok(paths)}
 for path in paths {if !order.contains(&path){order.push(path)}}
 Ok(order)
}
fn rewrite_category_metadata(dir:&Path,root:&Path)->Result<(),String>{
 for entry in fs::read_dir(dir).map_err(|e|e.to_string())? {let path=entry.map_err(|e|e.to_string())?.path();
  if path.is_dir(){rewrite_category_metadata(&path,root)?;continue}
  if path.extension().and_then(|x|x.to_str())!=Some("nod"){continue}
  let mut value:Value=serde_json::from_str(&fs::read_to_string(&path).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
  let category=path.parent().and_then(|parent|parent.strip_prefix(root).ok()).map(|relative|relative.to_string_lossy().replace('\\',"/")).unwrap_or_else(||"Default".into());
  value["category"]=Value::String(category);fs::write(&path,serde_json::to_string_pretty(&value).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
 } Ok(())
}
#[tauri::command]
pub fn list_node_definitions(library_folder: String) -> Result<Vec<Value>,String> {
 if library_folder.trim().is_empty(){return Ok(Vec::new())}
 let root=PathBuf::from(library_folder); ensure_library(&root)?;
 let mut out=Vec::new();
 fn collect(dir:&Path,root:&Path,out:&mut Vec<Value>)->Result<(),String>{
  for entry in fs::read_dir(dir).map_err(|e|e.to_string())? {
   let path=entry.map_err(|e|e.to_string())?.path();
   if path.is_dir(){collect(&path,root,out)?;continue}
   if path.extension().and_then(|x|x.to_str())!=Some("nod"){continue}
   let mut value:Value=serde_json::from_str(&fs::read_to_string(&path).map_err(|e|e.to_string())?).map_err(|e|format!("Invalid .nod definition: {e}"))?;
   let category=path.parent().and_then(|parent|parent.strip_prefix(root).ok()).map(|relative|relative.to_string_lossy().replace('\\',"/")).unwrap_or_else(||"Default".into());
   if let Some(obj)=value.as_object_mut(){obj.entry("category").or_insert(Value::String(category));}
   out.push(value);
  }
  Ok(())
 }
 collect(&root,&root,&mut out)?;
 out.sort_by(|a,b|a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))); Ok(out)
}
#[tauri::command]
pub fn create_node_category(library_folder:String, category:String)->Result<(),String>{
 let root=PathBuf::from(library_folder); ensure_library(&root)?; let relative=safe_relative(category.trim())?;
 let destination=root.join(relative);
 if destination.exists(){return Err("That category already exists.".into())}
 fs::create_dir_all(destination).map_err(|e|format!("Could not create category: {e}"))?;
 write_category_order(&root,&complete_category_order(&root)?)?;Ok(())
}
#[tauri::command]
pub fn list_node_categories(library_folder:String)->Result<Vec<String>,String>{
 if library_folder.trim().is_empty(){return Ok(vec!["Default".into()])}
 let root=PathBuf::from(library_folder); ensure_library(&root)?;
 let order=complete_category_order(&root)?;let mut items=collect_category_paths(&root)?;
 items.sort_by(|a,b|order.iter().position(|item|item==a).unwrap_or(usize::MAX).cmp(&order.iter().position(|item|item==b).unwrap_or(usize::MAX)).then_with(||a.cmp(b)));
 Ok(items)
}

#[tauri::command]
pub fn move_node_category(library_folder:String,category:String,destination_parent:String)->Result<(),String>{
 let root=PathBuf::from(library_folder);ensure_library(&root)?;
 let category=category.trim();if category=="Default"{return Err("The Default category cannot be moved because it contains permanent built-in nodes.".into())}
 let source_rel=safe_relative(category)?;let source=root.join(&source_rel);
 if !source.is_dir(){return Err("Could not find that category.".into())}
 let parent_rel=if destination_parent.trim().is_empty(){PathBuf::new()}else{safe_relative(destination_parent.trim())?};
 if !parent_rel.as_os_str().is_empty() && !root.join(&parent_rel).is_dir(){return Err("Choose an existing parent category or Root.".into())}
 let source_name=source_rel.file_name().ok_or("Invalid category name.")?;
 let destination_rel=parent_rel.join(source_name);let source_text=source_rel.to_string_lossy().replace('\\',"/");
 let destination_text=destination_rel.to_string_lossy().replace('\\',"/");
 if destination_text==source_text{return Ok(())}
 if destination_text.starts_with(&(source_text.clone()+"/")){return Err("A category cannot be moved inside itself or one of its subcategories.".into())}
 let destination=root.join(&destination_rel);if destination.exists(){return Err("A category with that name already exists under the selected parent.".into())}
 let mut order=complete_category_order(&root)?;
 fs::rename(&source,&destination).map_err(|e|format!("Could not move category: {e}"))?;
 rewrite_category_metadata(&destination,&root)?;
 for item in &mut order {if item==&source_text || item.starts_with(&(source_text.clone()+"/")){*item=format!("{}{}",destination_text,&item[source_text.len()..]);}}
 let paths=collect_category_paths(&root)?;order.retain(|item|paths.contains(item));
 for path in paths {if !order.contains(&path){order.push(path)}}
 write_category_order(&root,&order)?;Ok(())
}

#[tauri::command]
pub fn reorder_node_category(library_folder:String,category:String,direction:String)->Result<(),String>{
 let root=PathBuf::from(library_folder);ensure_library(&root)?;let category=category.trim();let rel=safe_relative(category)?;
 if !root.join(&rel).is_dir(){return Err("Could not find that category.".into())}
 let amount=match direction.as_str(){"up"=>-1,"down"=>1,_=>return Err("Choose up or down.".into())};
 let mut order=complete_category_order(&root)?;
 let parent=rel.parent().map(|value|value.to_string_lossy().replace('\\',"/")).unwrap_or_default();
 let siblings:Vec<String>=order.iter().filter(|path|{
  let candidate=Path::new(path.as_str());let candidate_parent=candidate.parent().map(|value|value.to_string_lossy().replace('\\',"/")).unwrap_or_default();candidate_parent==parent
 }).cloned().collect();
 let index=siblings.iter().position(|item|item==category).ok_or("Could not order that category.")?;
 let next=index as isize+amount;if next<0||next>=siblings.len() as isize{return Ok(())}
 let other=&siblings[next as usize];let current_index=order.iter().position(|item|item==category).ok_or("Could not order that category.")?;let other_index=order.iter().position(|item|item==other).ok_or("Could not order that category.")?;
 order.swap(current_index,other_index);write_category_order(&root,&order)
}
#[tauri::command]
pub fn save_node_definition(library_folder:String, definition:Value, category:String)->Result<(),String>{
 let root=PathBuf::from(library_folder); ensure_library(&root)?; let rel=safe_relative(category.trim())?;
 let folder=root.join(rel);
 if !folder.is_dir(){return Err("Node category does not exist.".into())}
 let name=definition["name"].as_str().ok_or("Node definition needs a name.")?;
 let safe:String=name.chars().map(|c|if c.is_ascii_alphanumeric()||c=='_'||c=='-' {c}else{'_'}).collect();
 let filename=if safe.is_empty(){"node".to_string()}else{safe};
 let path=folder.join(format!("{filename}.nod"));
 fn find_definition(dir:&Path,id:&Value)->Result<Option<PathBuf>,String>{
  for entry in fs::read_dir(dir).map_err(|e|e.to_string())? {let path=entry.map_err(|e|e.to_string())?.path();
   if path.is_dir(){if let Some(found)=find_definition(&path,id)?{return Ok(Some(found))};continue}
   if path.extension().and_then(|value|value.to_str())!=Some("nod"){continue}
   let existing:Value=serde_json::from_str(&fs::read_to_string(&path).map_err(|e|e.to_string())?).map_err(|e|format!("Existing .nod definition is invalid: {e}"))?;
   if existing.get("id")==Some(id){return Ok(Some(path))}
  } Ok(None)
 }
 let previous_path=find_definition(&root,&definition["id"])?;
 if path.exists() {
  let existing:Value=serde_json::from_str(&fs::read_to_string(&path).map_err(|e|format!("Could not read existing node definition: {e}"))?).map_err(|e|format!("Existing .nod definition is invalid: {e}"))?;
  if existing["id"] != definition["id"] { return Err("A node with that name already exists in this category. Choose a different name.".into()) }
 }
 let contents=serde_json::to_string_pretty(&definition).map_err(|e|e.to_string())?;
 fs::write(&path,contents).map_err(|e|format!("Could not save node definition: {e}"))?;
 if let Some(previous)=previous_path { if previous != path { fs::remove_file(previous).map_err(|e|format!("Saved the updated definition, but could not remove its previous file: {e}"))?; } }
 Ok(())
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

#[cfg(test)]
mod tests {
 use super::*;
 use serde_json::json;
 use std::time::{SystemTime,UNIX_EPOCH};

 #[test]
 fn edited_definition_is_moved_and_renamed_without_a_duplicate(){
  let nonce=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
  let root=std::env::temp_dir().join(format!("visual-code-node-test-{nonce}"));
  let library=root.join("Nodes.py");
  let mut definition=json!({"id":"definition-1","name":"First","kind":"function","inputs":[],"outputs":[],"template":"","outputTemplates":[]});
  save_node_definition(library.to_string_lossy().to_string(),definition.clone(),"Default".into()).unwrap();
  create_node_category(library.to_string_lossy().to_string(),"Utilities/Math".into()).unwrap();
  definition["name"]=Value::String("Renamed".into());
  definition["category"]=Value::String("Utilities/Math".into());
  save_node_definition(library.to_string_lossy().to_string(),definition,"Utilities/Math".into()).unwrap();
  let listed=list_node_definitions(library.to_string_lossy().to_string()).unwrap();
  assert_eq!(listed.len(),1);
  assert_eq!(listed[0]["name"],"Renamed");
  assert_eq!(listed[0]["category"],"Utilities/Math");
  assert!(!library.join("Default/First.nod").exists());
  let categories=list_node_categories(library.to_string_lossy().to_string()).unwrap();
  assert!(categories.contains(&"Utilities/Math".to_string()));
  create_node_category(library.to_string_lossy().to_string(),"Utilities/Text".into()).unwrap();
  move_node_category(library.to_string_lossy().to_string(),"Utilities/Math".into(),"".into()).unwrap();
  let moved=list_node_categories(library.to_string_lossy().to_string()).unwrap();
  assert!(moved.contains(&"Math".to_string()));
  assert!(!moved.contains(&"Utilities/Math".to_string()));
  create_node_category(library.to_string_lossy().to_string(),"Zed".into()).unwrap();
  reorder_node_category(library.to_string_lossy().to_string(),"Math".into(),"down".into()).unwrap();
  let reordered=list_node_categories(library.to_string_lossy().to_string()).unwrap();
  assert!(reordered.iter().position(|item|item=="Math").unwrap()>reordered.iter().position(|item|item=="Zed").unwrap());
  move_node_category(library.to_string_lossy().to_string(),"Math".into(),"Utilities".into()).unwrap();
  let returned=list_node_definitions(library.to_string_lossy().to_string()).unwrap();
  assert_eq!(returned[0]["category"],"Utilities/Math");
  fs::remove_dir_all(root).unwrap();
 }
}
