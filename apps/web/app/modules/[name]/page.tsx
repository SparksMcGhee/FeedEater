import { ModulePage } from "../../../components/ModulePage";

export default function ModuleDetailPage(props: { params: { name: string } }) {
  return <ModulePage moduleName={props.params.name} />;
}
